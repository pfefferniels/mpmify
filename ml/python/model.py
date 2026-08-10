"""Small encoder-decoder transformer: continuous note features -> tempo-DSL tokens.

From v4 the model is a **hybrid** (LOG.md, 2026-08-09 architecture decision): the decoder
emits the segment maps (tempo, dynamics, rubato, asynchrony) as DSL tokens, while the
note-anchored bands -- articulation and pedal state -- are read off the ENCODER, one
prediction per note. v3.1 established why: a decoder can learn articulation's marginal
statistics but not *which note* was articulated (18/196 dates within +-1 beat), because
transcribing a note index into digit tokens is a pointer problem, not a generation one.
A per-note head makes the date exact by construction and costs a median 186 tokens less.

The heads are opt-in (``heads=False``): with the flag off the module has no extra
parameters and every pre-heads checkpoint loads unchanged.
"""

import math

import torch
import torch.nn as nn

from dsl import VOCAB
from dataset import N_FEATURES


#: Readout scale for ``velocityChange``. The head regresses in units of this constant so the
#: multi-task L1 terms share an order of magnitude (the sampler's velocityChange spans
#: +-25 with sd ~12, against a relativeDuration that lives within ~0.3 of 1.0); without it
#: the velocity term alone would be ~40x the others and set the head's effective weight.
VEL_CHANGE_SCALE = 16.0

#: Pedal is regressed in [0, 1] through a sigmoid and read out in CC units.
PEDAL_SCALE = 127.0

#: The keys :meth:`TempoTransformer.note_heads` returns, in readout units.
NOTE_HEAD_KEYS = ("artic_logit", "rel_dur", "vel_change", "pedal_state")


class PositionalEncoding(nn.Module):
    def __init__(self, d_model, max_len=2048):
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        pos = torch.arange(max_len).unsqueeze(1).float()
        div = torch.exp(torch.arange(0, d_model, 2).float() * (-math.log(10000.0) / d_model))
        pe[:, 0::2] = torch.sin(pos * div)
        pe[:, 1::2] = torch.cos(pos * div)
        self.register_buffer("pe", pe)

    def forward(self, x):
        return x + self.pe[: x.shape[1]].unsqueeze(0)


class NoteHeads(nn.Module):
    """Per-note predictions from one encoder position: articulation and pedal state.

    A shared 2-layer trunk feeds a single 4-wide projection, so the four outputs see the
    same representation -- they are not independent bands of the performance: an
    articulation's relativeDuration and its velocityChange are sampled together, and a
    staccato under a held pedal sounds different from one without it.

    The three regressed outputs are parameterised around their *neutral* values so an
    untrained head starts at "no articulation, pedal up" rather than at an arbitrary point:
    ``rel_dur`` is ``1 + raw`` (1.0 = duration unchanged) and ``vel_change`` is
    ``scale * raw`` (0.0 = velocity unchanged).
    """

    def __init__(self, d_model, dropout=0.1):
        super().__init__()
        self.trunk = nn.Sequential(
            nn.Linear(d_model, d_model), nn.GELU(), nn.Dropout(dropout),
            nn.Linear(d_model, d_model), nn.GELU(),
        )
        self.out = nn.Linear(d_model, 4)

    def forward(self, memory):
        h = self.out(self.trunk(memory))
        return {
            "artic_logit": h[..., 0],
            "rel_dur": 1.0 + h[..., 1],
            "vel_change": VEL_CHANGE_SCALE * h[..., 2],
            "pedal_state": PEDAL_SCALE * torch.sigmoid(h[..., 3]),
        }


class TempoTransformer(nn.Module):
    def __init__(self, d_model=256, nhead=8, enc_layers=4, dec_layers=4, ff=1024,
                 dropout=0.1, n_features=N_FEATURES, vocab_size=None, heads=False):
        super().__init__()
        vocab_size = vocab_size or len(VOCAB)
        self.in_proj = nn.Sequential(
            nn.Linear(n_features, d_model), nn.GELU(), nn.Linear(d_model, d_model)
        )
        self.pos_enc = PositionalEncoding(d_model)
        self.tok_emb = nn.Embedding(vocab_size, d_model)
        self.pos_dec = PositionalEncoding(d_model)
        self.transformer = nn.Transformer(
            d_model=d_model, nhead=nhead,
            num_encoder_layers=enc_layers, num_decoder_layers=dec_layers,
            dim_feedforward=ff, dropout=dropout, batch_first=True, norm_first=True,
        )
        self.head = nn.Linear(d_model, vocab_size)
        # `heads=False` adds no parameters and no state-dict keys, so a checkpoint from
        # v1..v4-phase-1 loads into this class unchanged.
        self.note_mlp = NoteHeads(d_model, dropout) if heads else None

    @property
    def has_heads(self):
        return self.note_mlp is not None

    def encode(self, x, x_pad_mask):
        """Encoder memory: one vector per note, the per-note heads' input."""
        return self.transformer.encoder(self.pos_enc(self.in_proj(x)),
                                        src_key_padding_mask=x_pad_mask)

    def forward(self, x, x_pad_mask, y_in, return_heads=False):
        """Token logits, and (optionally) the per-note head outputs from the same pass.

        The encoder and decoder are called separately rather than through
        ``nn.Transformer.forward``, which is exactly what that method does internally --
        the split is what lets a heads run reuse one encoder pass for both objectives
        instead of paying for two. ``greedy_decode`` has always called them this way.
        """
        memory = self.encode(x, x_pad_mask)
        tgt = self.pos_dec(self.tok_emb(y_in))
        T = y_in.shape[1]
        causal = nn.Transformer.generate_square_subsequent_mask(T, device=y_in.device)
        out = self.transformer.decoder(
            tgt, memory, tgt_mask=causal, memory_key_padding_mask=x_pad_mask
        )
        logits = self.head(out)
        if not return_heads:
            return logits
        if self.note_mlp is None:
            raise RuntimeError("return_heads=True on a model built with heads=False")
        return logits, self.note_mlp(memory)

    def note_heads(self, x, x_pad_mask):
        """``{artic_logit, rel_dur, vel_change, pedal_state}``, each ``(B, N)``.

        Readout units: ``artic_logit`` is a raw logit (apply a sigmoid for the probability),
        ``vel_change`` is in MIDI velocity units and ``pedal_state`` in CC units 0..127.
        Padded positions carry values too -- the caller masks them with the same
        ``x_pad_mask`` it passed in.
        """
        if self.note_mlp is None:
            raise RuntimeError("model was built with heads=False; no per-note heads exist")
        return self.note_mlp(self.encode(x, x_pad_mask))

    @torch.no_grad()
    def greedy_decode(self, x, x_pad_mask, max_len=256, bos=1, eos=2):
        self.eval()
        B = x.shape[0]
        memory = self.encode(x, x_pad_mask)
        ys = torch.full((B, 1), bos, dtype=torch.long, device=x.device)
        done = torch.zeros(B, dtype=torch.bool, device=x.device)
        for _ in range(max_len - 1):
            tgt = self.pos_dec(self.tok_emb(ys))
            T = ys.shape[1]
            causal = nn.Transformer.generate_square_subsequent_mask(T, device=x.device)
            out = self.transformer.decoder(
                tgt, memory, tgt_mask=causal, memory_key_padding_mask=x_pad_mask
            )
            nxt = self.head(out[:, -1]).argmax(-1)
            nxt = torch.where(done, torch.full_like(nxt, 0), nxt)
            ys = torch.cat([ys, nxt.unsqueeze(1)], dim=1)
            done |= nxt == eos
            if bool(done.all()):
                break
        return ys
