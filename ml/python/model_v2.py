"""fenby v1.0 model — the study's hybrid, rebuilt config-driven on custom SDPA blocks.

`model.py` is frozen: every v1-v4 checkpoint in `ml/runs/` was trained with it and must keep
loading. This module is its successor for the production system (SYSTEM.md §2.2) and changes
four things, each for a reason the study's log already paid for:

**1. Custom blocks instead of `nn.Transformer`.** The forward path is
``F.scaled_dot_product_attention`` over explicit q/k/v, so the attention kernel is visible
and choosable (flash/mem-efficient on H100, math on CPU/MPS), a KV cache can be added to
``greedy_decode`` without forking a library class, and RoPE can be applied to q/k where
``nn.MultiheadAttention`` gives no hook. The block *layout* is a deliberate replica of
``nn.TransformerEncoderLayer(norm_first=True)`` down to the parameter names and shapes
(``in_proj_weight``/``in_proj_bias``/``out_proj``, ``linear1``/``linear2``,
``norm1``..``norm3``), which is what makes :func:`state_dict_from_v1` a pure rename and lets
the base config stand as an exact regression anchor: same parameter count, same
initialisation family, same residual/dropout order.

**2. Positional encoding is a config choice, and the default is sinusoidal.**
``pos="sinusoidal"`` is bit-identical to `model.py` (the same
:class:`model.PositionalEncoding` object, imported rather than copied) and is what both
shipped configs use, so ``large`` vs ``base`` is a pure scale comparison — one variable, per
the program's method. ``pos="rope"`` is implemented and tested because the v1.0 corpus
change makes it matter: the study's pieces are 16-48 beats (<= 320 notes, <= 512 tokens) while
real repertoire movements are an order of magnitude longer, and absolute sinusoidal
embeddings degrade off the trained length range whereas rotary embeddings encode *relative*
offsets in the attention logits and interpolate/extrapolate far better. It is one config key
away and is the natural first ablation once the scale-up run exists — deliberately NOT folded
into the ``large`` run, which would confound it with the size change. RoPE is applied to
self-attention only; cross-attention queries (decoder token positions) and keys (encoder note
positions) live in different coordinate systems, so a shared rotation there would encode a
meaningless "relative offset" between a token index and a note index.

**3. The f14 pedal leak is fixed (LOG.md, 2026-08-10 Vienna re-probe).** ``pedal_state`` is
feature 14 *and* the fourth per-note head target, so the 0.3cc/1.17cc pedal MAEs the v4 runs
reported were largely the head copying its own input — plumbing-valid, not an ML result.
``exclude_features=[14]`` drops the column before the input projection: not zeroed, *removed*,
so the weight for it does not exist and the model's output is provably (see
``tests_model_v2.py``) invariant to that column at exactly 0.0 difference. ``n_features``
still records the width of the pack, so `eval_ckpt.py`'s feature-width guard keeps working
and the same v41 pack feeds a leaking and a non-leaking run — the ablation is one config key.

**4. Everything is in the config, and the config is in the checkpoint.** Architecture is
never inferred from a flag or a file name; ``resolve_model_cfg`` derives ``n_features`` and
``vocab_size`` from the mode and aborts if a config contradicts them, and unknown keys are an
abort rather than a silent default (a typo'd key in a run config is a run that lies about
what it was). The five keys that *define* the architecture are **required** in a run config
file: a config that omits ``d_model`` and silently gets 192 is the same failure as a
defaulted architecture, one level down. The remaining keys keep documented defaults and the
run prints exactly which ones it took (``defaults: model[...] train[...]``), so a default is
recorded, never silent.

**5. The run is seeded, and the seed is part of the schedule.** ``train.seed`` (default 0)
seeds weight init, dropout and batch order through :func:`seed_everything`; without it two
runs of the same command are two different runs, and "reproducible from its own record" is
only true of the architecture. Batch order is drawn from a *local* ``random.Random(seed,
epoch)`` so it is a function of the epoch index alone and a resume replays the order the
uninterrupted run would have used.
"""

from __future__ import annotations

import json
import random
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

from dataset import (N_FEATURES, N_FEATURES_V2, N_FEATURES_V31, N_FEATURES_V4,
                     N_FEATURES_V41, piece_to_features_v4, piece_to_features_v41)
from dsl import V1_VOCAB_SIZE, V2_VOCAB_SIZE, V3_VOCAB_SIZE, V4_VOCAB_SIZE
# Imported, not re-implemented: the per-note heads and the sinusoidal table are exactly the
# objects the v4 verdict runs used, so `base` differs from `model.py` in the encoder/decoder
# internals and in nothing else.
from model import (NOTE_HEAD_KEYS, PEDAL_SCALE, VEL_CHANGE_SCALE, NoteHeads,
                   PositionalEncoding)

__all__ = ["HybridTransformer", "PEDAL_FEATURE_INDEX", "MODE_FEATURES", "MODE_VOCAB",
           "MODE_MAX_DECODE", "FEATURE_NAMES", "MODEL_DEFAULTS", "REQUIRED_MODEL_KEYS",
           "build_model", "resolve_model_cfg", "load_run_config", "head_losses",
           "state_dict_from_v1", "param_count", "verify_pedal_index", "seed_everything",
           "defaulted_keys", "describe_exclusions", "NOTE_HEAD_KEYS", "PEDAL_SCALE",
           "VEL_CHANGE_SCALE"]

#: Index of ``pedal_state`` in the per-note feature row. The same index in BOTH v4 layouts:
#: `dataset.piece_to_features_v4` appends ``part`` (13) then ``pedal_state`` (14), and
#: `piece_to_features_v41` appends ``cross_part_offset`` (15) after them.
#:
#: This constant is a claim about another module's output layout, so it is not left to a
#: docstring: :func:`verify_pedal_index` *runs* the extractor and proves the column, and
#: `train_v2.check_pedal_leak` calls it before every run. A re-preprocessed corpus that moves
#: the column would otherwise reinstate the leak under a log line still reading "EXCLUDED".
PEDAL_FEATURE_INDEX = 14

#: Names for the feature indices the configs address by number, so a log line can say *which*
#: column it dropped. Only the v4/v4.1 tail is named — the shared v3.1 head is documented in
#: `dataset.piece_to_features_v31` and no config refers to it by index.
FEATURE_NAMES = {13: "part", 14: "pedal_state", 15: "cross_part_offset"}

#: Feature width per mode — the same table `train.py` spells inline, kept here so a config
#: cannot disagree with the pack it will be trained on.
MODE_FEATURES = {"v1": N_FEATURES, "v2": N_FEATURES_V2, "v3": N_FEATURES_V2,
                 "v31": N_FEATURES_V31, "v4": N_FEATURES_V4, "v41": N_FEATURES_V41}
#: Frozen per-version vocabularies (never bare ``len(VOCAB)``: appending tokens for a new
#: version must not desync resumable checkpoints). v3.1 and v4.1 share their parent's grammar.
MODE_VOCAB = {"v1": V1_VOCAB_SIZE, "v2": V2_VOCAB_SIZE, "v3": V3_VOCAB_SIZE,
              "v31": V3_VOCAB_SIZE, "v4": V4_VOCAB_SIZE, "v41": V4_VOCAB_SIZE}
#: Decode budget per mode, used only when a pack predates ``max_tgt``. **One table for the
#: whole v2 path**: `train_v2` (epoch-end eval) and `eval_ckpt_v2` (offline re-scoring) both
#: import this, so the two cannot decode to different lengths under the same run name.
#: `eval_ckpt.DEFAULT_MAX_DECODE` says 320 for v4 and has no v41 key at all; a v2 checkpoint
#: is never scored against that table.
MODE_MAX_DECODE = {"v1": 224, "v2": 320, "v3": 448, "v31": 448, "v4": 512, "v41": 512}
#: Modes whose pack carries per-note labels (and therefore can run the heads).
HEAD_MODES = ("v4", "v41")

#: Keys a run config may carry. Unknown keys abort — see the module docstring.
TOP_KEYS = {"name", "note", "arch", "mode", "model", "train", "allow_pedal_leak"}
MODEL_KEYS = {"d_model", "nhead", "enc_layers", "dec_layers", "ff", "dropout", "pos",
              "activation", "exclude_features", "max_len", "heads", "n_features",
              "vocab_size"}
TRAIN_KEYS = {"epochs", "batch", "lr", "warmup", "weight_decay", "head_weight", "clip",
              "seed", "eval_pieces", "eval_every", "decode_batch", "final_eval_pieces"}

#: The five keys that DEFINE the architecture. A run config file must state them: silently
#: defaulting `d_model` is the same defect as a defaulted architecture, one level down.
#: (Enforced in :func:`load_run_config`, i.e. where configs enter from disk, not in
#: :func:`resolve_model_cfg`, which also serves callers that build a kwargs dict directly.)
REQUIRED_MODEL_KEYS = ("d_model", "nhead", "enc_layers", "dec_layers", "ff")
#: Documented defaults for the keys a config may omit. Omission is legal but never silent:
#: :func:`defaulted_keys` reports what was taken and `train_v2` prints it before step 1.
MODEL_DEFAULTS = {"dropout": 0.1, "pos": "sinusoidal", "activation": "relu",
                  "exclude_features": [], "max_len": 2048}

ACTIVATIONS = {"relu": F.relu, "gelu": F.gelu}


def seed_everything(seed):
    """Seed python/torch RNGs. Returns the seed, so a caller can log what it applied.

    Weight init, dropout and any shuffling downstream of the global RNG come from here.
    Batch order deliberately does NOT: it is drawn per epoch from a local
    ``random.Random`` in `train_v2`, so a resumed run replays the order the uninterrupted
    run would have used instead of continuing from whatever global state a resume happens
    to start in.
    """
    seed = int(seed)
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    return seed


def verify_pedal_index(mode, index=PEDAL_FEATURE_INDEX):
    """Prove that ``index`` is the ``pedal_state`` column of ``mode``'s feature row.

    Not an assertion against a docstring — the extractor is *run* twice on the same two-note
    record, once with an empty sustain stream and once with the pedal down from ms 0, and the
    set of columns that move must be exactly ``{index}``. That catches both halves of the
    risk: a layout change that moves ``pedal_state`` elsewhere (the set would not contain
    ``index``) and one that spreads the pedal signal over more columns.

    Returns a one-line evidence string; raises ``SystemExit`` if the claim is false.
    """
    if mode not in HEAD_MODES:
        return f"n/a (mode {mode} has no pedal feature)"
    fn = piece_to_features_v41 if mode == "v41" else piece_to_features_v4
    rec = {"notes": [[0, 720, 60, 0.0, 500.0, 80], [720, 720, 62, 500.0, 1000.0, 80]],
           "total_ticks": 1440}
    up = fn(dict(rec, sustain_cc=[]))
    down = fn(dict(rec, sustain_cc=[[0.0, 127.0]]))
    width = len(up[0])
    moved = sorted({j for a, b in zip(up, down) for j in range(width) if a[j] != b[j]})
    if moved != [index]:
        raise SystemExit(
            f"ABORT: PEDAL_FEATURE_INDEX={index} is wrong for mode {mode}. Pressing the "
            f"sustain pedal moves feature column(s) {moved} of {width}, not [{index}]. The "
            f"pack layout changed under model_v2: every config's `exclude_features` and the "
            f"'f14_pedal=EXCLUDED' log line are now lies. Fix PEDAL_FEATURE_INDEX and "
            f"FEATURE_NAMES against dataset.py before training anything.")
    if width != MODE_FEATURES[mode]:
        raise SystemExit(f"ABORT: mode {mode} declares {MODE_FEATURES[mode]} features but "
                         f"dataset.py produced {width}")
    return (f"f{index} ({FEATURE_NAMES.get(index, '?')}) verified against dataset.py: "
            f"pedal down moves columns {moved} of {width} and nothing else")


# --------------------------------------------------------------------------------------
# attention
# --------------------------------------------------------------------------------------

class RotaryEmbedding(nn.Module):
    """Rotary position embedding over q/k (Su et al., RoFormer), interleaved-pair form.

    Costs no parameters and enters the attention logits as a function of the *offset*
    ``m - n`` only, which is the property that makes it hold up on sequences longer than
    anything seen in training — the reason it is here at all (see the module docstring).
    """

    def __init__(self, head_dim, base=10000.0, max_len=8192):
        super().__init__()
        if head_dim % 2:
            raise ValueError(f"rope needs an even head_dim, got {head_dim}")
        inv = 1.0 / (base ** (torch.arange(0, head_dim, 2).float() / head_dim))
        freqs = torch.outer(torch.arange(max_len).float(), inv)   # (L, hd/2)
        self.register_buffer("cos", freqs.cos()[None, None], persistent=False)
        self.register_buffer("sin", freqs.sin()[None, None], persistent=False)
        self.max_len = max_len

    def forward(self, x):
        """``x`` is ``(B, H, T, head_dim)``; returns it rotated by its own position."""
        t = x.shape[-2]
        if t > self.max_len:
            raise ValueError(f"rope table is {self.max_len} long, got a sequence of {t}")
        cos, sin = self.cos[..., :t, :].to(x.dtype), self.sin[..., :t, :].to(x.dtype)
        x1, x2 = x[..., 0::2], x[..., 1::2]
        out = torch.empty_like(x)
        out[..., 0::2] = x1 * cos - x2 * sin
        out[..., 1::2] = x1 * sin + x2 * cos
        return out


class SelfAttention(nn.Module):
    """Multi-head self-attention through ``F.scaled_dot_product_attention``.

    Parameter names and shapes replicate ``nn.MultiheadAttention`` exactly
    (``in_proj_weight`` ``(3d, d)``, ``in_proj_bias`` ``(3d,)``, ``out_proj``) so that the
    xavier fan-in/fan-out `nn.Transformer._reset_parameters` would compute is the same one
    here, and so a v1 checkpoint transplants by rename alone.
    """

    def __init__(self, d_model, nhead, dropout):
        super().__init__()
        if d_model % nhead:
            raise ValueError(f"d_model {d_model} not divisible by nhead {nhead}")
        self.nhead = nhead
        self.head_dim = d_model // nhead
        self.dropout = dropout
        self.in_proj_weight = nn.Parameter(torch.empty(3 * d_model, d_model))
        self.in_proj_bias = nn.Parameter(torch.zeros(3 * d_model))
        self.out_proj = nn.Linear(d_model, d_model)

    def forward(self, x, key_padding_mask=None, is_causal=False, rope=None):
        b, t, c = x.shape
        q, k, v = F.linear(x, self.in_proj_weight, self.in_proj_bias).split(c, dim=-1)
        q, k, v = (z.view(b, t, self.nhead, self.head_dim).transpose(1, 2)
                   for z in (q, k, v))
        if rope is not None:
            q, k = rope(q), rope(k)
        attn_mask = None
        if key_padding_mask is not None:
            # SDPA takes True = attend; the pack's mask is True = padding.
            attn_mask = (~key_padding_mask)[:, None, None, :]
        o = F.scaled_dot_product_attention(
            q, k, v, attn_mask=attn_mask, is_causal=is_causal,
            dropout_p=self.dropout if self.training else 0.0)
        return self.out_proj(o.transpose(1, 2).reshape(b, t, c))


class CrossAttention(nn.Module):
    """Decoder->encoder attention. Same parameter layout as ``nn.MultiheadAttention``: one
    fused ``(3d, d)`` projection, of which the first ``d`` rows serve the query (from the
    decoder) and the remaining ``2d`` the key/value (from the memory). No RoPE — the two
    sides index different things (token position vs note position)."""

    def __init__(self, d_model, nhead, dropout):
        super().__init__()
        if d_model % nhead:
            raise ValueError(f"d_model {d_model} not divisible by nhead {nhead}")
        self.d_model = d_model
        self.nhead = nhead
        self.head_dim = d_model // nhead
        self.dropout = dropout
        self.in_proj_weight = nn.Parameter(torch.empty(3 * d_model, d_model))
        self.in_proj_bias = nn.Parameter(torch.zeros(3 * d_model))
        self.out_proj = nn.Linear(d_model, d_model)

    def forward(self, x, memory, memory_key_padding_mask=None):
        b, t, c = x.shape
        d = self.d_model
        q = F.linear(x, self.in_proj_weight[:d], self.in_proj_bias[:d])
        kv = F.linear(memory, self.in_proj_weight[d:], self.in_proj_bias[d:])
        k, v = kv.split(d, dim=-1)
        s = memory.shape[1]
        q = q.view(b, t, self.nhead, self.head_dim).transpose(1, 2)
        k = k.view(b, s, self.nhead, self.head_dim).transpose(1, 2)
        v = v.view(b, s, self.nhead, self.head_dim).transpose(1, 2)
        attn_mask = None
        if memory_key_padding_mask is not None:
            attn_mask = (~memory_key_padding_mask)[:, None, None, :]
        o = F.scaled_dot_product_attention(
            q, k, v, attn_mask=attn_mask,
            dropout_p=self.dropout if self.training else 0.0)
        return self.out_proj(o.transpose(1, 2).reshape(b, t, c))


# --------------------------------------------------------------------------------------
# blocks
# --------------------------------------------------------------------------------------

class EncoderBlock(nn.Module):
    """Pre-norm ``x + attn(norm1(x))`` / ``x + ff(norm2(x))``, dropout placed exactly where
    ``nn.TransformerEncoderLayer`` places it (after the attention output, inside the FF
    between the activation and ``linear2``, and after ``linear2``)."""

    def __init__(self, d_model, nhead, ff, dropout, activation):
        super().__init__()
        self.self_attn = SelfAttention(d_model, nhead, dropout)
        self.linear1 = nn.Linear(d_model, ff)
        self.linear2 = nn.Linear(ff, d_model)
        self.norm1 = nn.LayerNorm(d_model)
        self.norm2 = nn.LayerNorm(d_model)
        self.dropout = nn.Dropout(dropout)
        self.dropout1 = nn.Dropout(dropout)
        self.dropout2 = nn.Dropout(dropout)
        self.act = ACTIVATIONS[activation]

    def forward(self, x, key_padding_mask=None, rope=None):
        x = x + self.dropout1(self.self_attn(self.norm1(x), key_padding_mask, rope=rope))
        h = self.norm2(x)
        return x + self.dropout2(self.linear2(self.dropout(self.act(self.linear1(h)))))


class DecoderBlock(nn.Module):
    """Pre-norm self-attn (causal) / cross-attn / FF, mirroring ``nn.TransformerDecoderLayer``."""

    def __init__(self, d_model, nhead, ff, dropout, activation):
        super().__init__()
        self.self_attn = SelfAttention(d_model, nhead, dropout)
        self.cross_attn = CrossAttention(d_model, nhead, dropout)
        self.linear1 = nn.Linear(d_model, ff)
        self.linear2 = nn.Linear(ff, d_model)
        self.norm1 = nn.LayerNorm(d_model)
        self.norm2 = nn.LayerNorm(d_model)
        self.norm3 = nn.LayerNorm(d_model)
        self.dropout = nn.Dropout(dropout)
        self.dropout1 = nn.Dropout(dropout)
        self.dropout2 = nn.Dropout(dropout)
        self.dropout3 = nn.Dropout(dropout)
        self.act = ACTIVATIONS[activation]

    def forward(self, x, memory, memory_key_padding_mask=None, rope=None):
        x = x + self.dropout1(self.self_attn(self.norm1(x), is_causal=True, rope=rope))
        x = x + self.dropout2(self.cross_attn(self.norm2(x), memory,
                                              memory_key_padding_mask))
        h = self.norm3(x)
        return x + self.dropout3(self.linear2(self.dropout(self.act(self.linear1(h)))))


class Stack(nn.Module):
    """``layers`` + the final ``norm`` that ``nn.Transformer`` adds under ``norm_first``."""

    def __init__(self, layers, d_model):
        super().__init__()
        self.layers = nn.ModuleList(layers)
        self.norm = nn.LayerNorm(d_model)


# --------------------------------------------------------------------------------------
# the model
# --------------------------------------------------------------------------------------

class HybridTransformer(nn.Module):
    """Encoder over per-note features + DSL decoder + optional per-note heads.

    Interface-compatible with :class:`model.TempoTransformer` (``encode``, ``forward``,
    ``note_heads``, ``greedy_decode``, ``has_heads``), so `eval_ckpt.run_eval` scores it
    without a second implementation of the decode-and-score loop.
    """

    def __init__(self, d_model=192, nhead=8, enc_layers=4, dec_layers=4, ff=768,
                 dropout=0.1, n_features=N_FEATURES_V41, vocab_size=None, heads=False,
                 pos="sinusoidal", activation="relu", exclude_features=(), max_len=2048):
        super().__init__()
        vocab_size = int(vocab_size or V4_VOCAB_SIZE)
        if pos not in ("sinusoidal", "rope"):
            raise ValueError(f"pos must be sinusoidal|rope, got {pos!r}")
        if activation not in ACTIVATIONS:
            raise ValueError(f"activation must be relu|gelu, got {activation!r}")
        exclude = tuple(sorted(int(i) for i in (exclude_features or ())))
        if len(set(exclude)) != len(exclude):
            raise ValueError(f"exclude_features has duplicates: {exclude_features}")
        if any(i < 0 or i >= n_features for i in exclude):
            raise ValueError(f"exclude_features {exclude} out of range for "
                             f"n_features={n_features}")
        self.n_features = int(n_features)
        self.exclude_features = exclude
        self.d_model = d_model
        self.vocab_size = vocab_size
        self.pos_kind = pos
        keep = [i for i in range(self.n_features) if i not in set(exclude)]
        if not keep:
            raise ValueError("exclude_features removes every input feature")
        # not persistent: it is derived from the config, and a buffer in the state dict would
        # make a config change look like a weight mismatch instead of a config mismatch
        self.register_buffer("keep_idx", torch.tensor(keep, dtype=torch.long),
                             persistent=False)
        self.in_dim = len(keep)

        self.in_proj = nn.Sequential(
            nn.Linear(self.in_dim, d_model), nn.GELU(), nn.Linear(d_model, d_model))
        self.tok_emb = nn.Embedding(vocab_size, d_model)
        self.head = nn.Linear(d_model, vocab_size)
        if pos == "sinusoidal":
            self.pos_enc = PositionalEncoding(d_model, max_len)
            self.pos_dec = PositionalEncoding(d_model, max_len)
            self.rope = None
        else:
            self.pos_enc = self.pos_dec = None
            self.rope = RotaryEmbedding(d_model // nhead, max_len=max_len)
        self.encoder = Stack([EncoderBlock(d_model, nhead, ff, dropout, activation)
                              for _ in range(enc_layers)], d_model)
        self.decoder = Stack([DecoderBlock(d_model, nhead, ff, dropout, activation)
                              for _ in range(dec_layers)], d_model)
        # `heads=False` adds no parameters and no state-dict keys, exactly as in model.py.
        self.note_mlp = NoteHeads(d_model, dropout) if heads else None

        # nn.Transformer._reset_parameters: xavier_uniform_ on every parameter with dim > 1,
        # applied to the encoder/decoder stacks only (in_proj / tok_emb / head keep their
        # module defaults, as in model.py). Replicated so `base` is a training-dynamics
        # anchor and not merely a parameter-count one.
        for p in list(self.encoder.parameters()) + list(self.decoder.parameters()):
            if p.dim() > 1:
                nn.init.xavier_uniform_(p)
        for m in self.modules():
            if isinstance(m, (SelfAttention, CrossAttention)):
                nn.init.zeros_(m.in_proj_bias)
                nn.init.zeros_(m.out_proj.bias)

    # ---- config -----------------------------------------------------------------
    @property
    def has_heads(self):
        return self.note_mlp is not None

    # ---- forward ----------------------------------------------------------------
    def _select(self, x):
        if x.shape[-1] != self.n_features:
            raise ValueError(
                f"model expects {self.n_features} features per note, got {x.shape[-1]} "
                f"(a v4 pack is 15 wide and a v4.1 pack 16; check --data)")
        if not self.exclude_features:
            return x
        return x.index_select(-1, self.keep_idx)

    def encode(self, x, x_pad_mask):
        """Encoder memory: one vector per note, the per-note heads' input."""
        h = self.in_proj(self._select(x))
        if self.pos_enc is not None:
            h = self.pos_enc(h)
        for layer in self.encoder.layers:
            h = layer(h, x_pad_mask, rope=self.rope)
        return self.encoder.norm(h)

    def decode(self, memory, x_pad_mask, y_in):
        h = self.tok_emb(y_in)
        if self.pos_dec is not None:
            h = self.pos_dec(h)
        for layer in self.decoder.layers:
            h = layer(h, memory, x_pad_mask, rope=self.rope)
        return self.head(self.decoder.norm(h))

    def forward(self, x, x_pad_mask, y_in, return_heads=False):
        """Token logits, and (optionally) the per-note head outputs from the SAME encoder
        pass — a heads run must not pay for two."""
        memory = self.encode(x, x_pad_mask)
        logits = self.decode(memory, x_pad_mask, y_in)
        if not return_heads:
            return logits
        if self.note_mlp is None:
            raise RuntimeError("return_heads=True on a model built with heads=False")
        return logits, self.note_mlp(memory)

    def note_heads(self, x, x_pad_mask):
        """``{artic_logit, rel_dur, vel_change, pedal_state}``, each ``(B, N)``; readout
        units as in `model.NoteHeads`. Padded positions carry values — the caller masks."""
        if self.note_mlp is None:
            raise RuntimeError("model was built with heads=False; no per-note heads exist")
        return self.note_mlp(self.encode(x, x_pad_mask))

    @torch.no_grad()
    def greedy_decode(self, x, x_pad_mask, max_len=256, bos=1, eos=2):
        """Byte-for-byte the contract of `model.TempoTransformer.greedy_decode`: BOS start,
        argmax, PAD (0) once a sequence has emitted EOS, break when all have."""
        self.eval()
        b = x.shape[0]
        memory = self.encode(x, x_pad_mask)
        ys = torch.full((b, 1), bos, dtype=torch.long, device=x.device)
        done = torch.zeros(b, dtype=torch.bool, device=x.device)
        for _ in range(max_len - 1):
            nxt = self.decode(memory, x_pad_mask, ys)[:, -1].argmax(-1)
            nxt = torch.where(done, torch.full_like(nxt, 0), nxt)
            ys = torch.cat([ys, nxt.unsqueeze(1)], dim=1)
            done |= nxt == eos
            if bool(done.all()):
                break
        return ys


# --------------------------------------------------------------------------------------
# multi-task loss (identical to train.py's; bit-exactness is pinned in tests_model_v2.py)
# --------------------------------------------------------------------------------------

def head_losses(heads, lab, valid):
    """The four per-note terms, each already on a comparable scale.

    ``artic_present`` is a BCE over every real note; ``rel_dur`` and ``vel_change`` are L1
    over the **truly articulated** notes only -- the label is 1.0/0.0 (the neutral value)
    everywhere else, so training the regressors on the other 85 % of notes would teach them
    the marginal "no articulation" constant instead of the attribute. ``pedal_state`` is L1
    over every note, in the [0,1] domain the head regresses in.

    Returns ``(bce, l1_reldur, l1_vel, l1_pedal)``; a batch with no articulated note at all
    yields exact 0.0 for the two masked terms rather than a NaN from an empty mean.

    This is a deliberate re-statement of `train.py.head_losses` and not an import: `train.py`
    raises on import by design (its module body *is* a training run). `tests_model_v2.py`
    lifts that function out of the source with `ast` and asserts the two agree at exactly
    0.0 on random tensors, so the copy cannot drift silently.
    """
    present = lab[..., 0]
    artic = valid & (present > 0.5)
    n_artic = artic.sum().clamp(min=1)
    bce = nn.functional.binary_cross_entropy_with_logits(
        heads["artic_logit"][valid], present[valid])
    l1_reldur = ((heads["rel_dur"] - lab[..., 1]).abs() * artic).sum() / n_artic
    l1_vel = (((heads["vel_change"] - lab[..., 2]).abs() * artic).sum()
              / n_artic / VEL_CHANGE_SCALE)
    l1_pedal = ((heads["pedal_state"] - lab[..., 3]).abs()[valid]).mean() / PEDAL_SCALE
    return bce, l1_reldur, l1_vel, l1_pedal


# --------------------------------------------------------------------------------------
# config plumbing
# --------------------------------------------------------------------------------------

def _reject_unknown(where, got, allowed):
    extra = sorted(set(got) - allowed - {k for k in got if str(k).startswith("_")})
    if extra:
        raise SystemExit(
            f"ABORT: unknown key(s) {extra} in the {where} block of the run config. "
            f"Allowed: {sorted(allowed)}. (A key that is silently ignored is a run that "
            f"reports a setting it never applied; prefix a comment with '_'.)")


def load_run_config(path):
    """Read a JSON run config, validate its keys, return it unchanged otherwise."""
    cfg = json.loads(Path(path).read_text())
    if not isinstance(cfg, dict):
        raise SystemExit(f"ABORT: {path} is not a JSON object")
    _reject_unknown("top-level", cfg, TOP_KEYS)
    _reject_unknown("model", cfg.get("model") or {}, MODEL_KEYS)
    _reject_unknown("train", cfg.get("train") or {}, TRAIN_KEYS)
    if cfg.get("arch", "model_v2") != "model_v2":
        raise SystemExit(f"ABORT: {path} declares arch={cfg['arch']!r}; this is model_v2")
    block = cfg.get("model") or {}
    absent = [k for k in REQUIRED_MODEL_KEYS if k not in block]
    if absent:
        raise SystemExit(
            f"ABORT: {path} does not state {absent} in its `model` block. These five keys "
            f"({list(REQUIRED_MODEL_KEYS)}) define the architecture and have no default: a "
            f"config that omits d_model and quietly gets 192 is exactly the run-that-cannot-"
            f"be-reproduced-from-its-record that --config was made mandatory to prevent.")
    return cfg


def defaulted_keys(block, defaults):
    """``{key: default}`` for every documented default this block did not state.

    A default is legitimate; a *silent* default is not. `train_v2` prints the result before
    the first optimiser step, so the run's own log records which values it inherited.
    """
    block = block or {}
    return {k: v for k, v in defaults.items() if k not in block}


def describe_exclusions(exclude):
    """``'[14:pedal_state]'`` — an excluded column named, not just numbered.

    The startup line used to say ``feat=16-1excl``, which is true of a run that dropped the
    wrong column too.
    """
    ex = list(exclude or [])
    if not ex:
        return "[]"
    return "[" + ",".join(f"{i}:{FEATURE_NAMES.get(i, '?')}" for i in ex) + "]"


def resolve_model_cfg(run_cfg, mode, *, heads):
    """The exact kwargs :class:`HybridTransformer` will be built with, for this mode.

    ``n_features`` and ``vocab_size`` are DERIVED from the mode; a config that states them
    must state them correctly (abort otherwise), which is what stops a hand-edited config
    from quietly training a 15-feature model on a 16-feature pack.
    """
    if mode not in MODE_FEATURES:
        raise SystemExit(f"ABORT: unknown mode {mode!r}; known: {sorted(MODE_FEATURES)}")
    block = dict((run_cfg.get("model") or {}))
    # `load_run_config` requires the five architecture keys of a config *file*; these
    # fallbacks serve direct callers (tests, notebooks) that pass a partial dict, and are
    # the same values `model.py`'s signature carries.
    cfg = {"d_model": 192, "nhead": 8, "enc_layers": 4, "dec_layers": 4, "ff": 768}
    cfg.update({k: (list(v) if isinstance(v, list) else v)
                for k, v in MODEL_DEFAULTS.items()})
    block.pop("heads", None)
    for k, v in block.items():
        if str(k).startswith("_"):      # '_'-prefixed keys are comments, never kwargs
            continue
        if k in ("n_features", "vocab_size"):
            want = MODE_FEATURES[mode] if k == "n_features" else MODE_VOCAB[mode]
            if int(v) != want:
                raise SystemExit(f"ABORT: config says {k}={v} but mode {mode} is {want}")
            continue
        cfg[k] = v
    cfg["n_features"] = MODE_FEATURES[mode]
    cfg["vocab_size"] = MODE_VOCAB[mode]
    cfg["heads"] = bool(heads)
    cfg["exclude_features"] = sorted(int(i) for i in cfg["exclude_features"])
    return cfg


def build_model(cfg):
    """``HybridTransformer(**cfg)`` — the one place a checkpoint's config becomes a model."""
    return HybridTransformer(**cfg)


def param_count(model):
    return sum(p.numel() for p in model.parameters())


def describe(cfg, model):
    ex = cfg.get("exclude_features") or []
    return (f"d{cfg['d_model']} {cfg['enc_layers']}+{cfg['dec_layers']} h{cfg['nhead']} "
            f"ff{cfg['ff']} {cfg['pos']}/{cfg['activation']} drop{cfg['dropout']} "
            f"feat={cfg['n_features']}-excl{describe_exclusions(ex)} "
            f"vocab={cfg['vocab_size']} heads={cfg['heads']} "
            f"params={param_count(model)/1e6:.2f}M")


# --------------------------------------------------------------------------------------
# the regression bridge
# --------------------------------------------------------------------------------------

def state_dict_from_v1(sd, enc_layers, dec_layers):
    """Rename a `model.TempoTransformer` state dict into this module's key space.

    A pure rename — every tensor is carried across unchanged, which is only possible because
    the blocks replicate ``nn.Transformer``'s parameter layout (fused ``in_proj_weight``
    included). Used by the equivalence probe: transplanting v1 weights and comparing the two
    forwards is the difference between "the shapes line up" and "it is the same function".

    Only valid for ``pos="sinusoidal"``, ``activation="relu"`` and ``exclude_features=()``.
    """
    out = {}
    for k, v in sd.items():
        if k.startswith("transformer."):
            k = k[len("transformer."):]
            k = k.replace("multihead_attn.", "cross_attn.")
        out[k] = v
    # the sinusoidal tables are buffers with identical content; keep them for a strict load
    for side, n in (("encoder", enc_layers), ("decoder", dec_layers)):
        for i in range(n):
            pref = f"{side}.layers.{i}."
            if pref + "self_attn.in_proj_weight" not in out:
                raise KeyError(f"missing {pref}self_attn.in_proj_weight in the v1 dict")
    return out
