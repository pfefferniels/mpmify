"""Acceptance checks for `model_v2.py` / `train_v2.py`.  ``python3 tests_model_v2.py``

No test framework (the ML tree's only dependency is torch): each check is a function that
prints what it measured and asserts on it, and the runner prints one PASS/FAIL line per
check plus a summary. Run a single one with ``python3 tests_model_v2.py <name>``.

The checks are ordered by what they would let through if they were missing:

``equivalence``  the base config IS the v4 architecture -- identical parameter count and,
                 with the v1 weights transplanted in, the same function to floating-point
                 noise. This is what makes `configs/base.json` a regression anchor rather
                 than a similarly-shaped model.
``leak``         the f14 fix is exact: with ``exclude_features=[14]`` the output does not
                 move by 0.0 when the pedal column is replaced with noise. A zeroing
                 implementation would pass a "looks excluded" eyeball test and still leak
                 through the bias-free path on the first optimiser step; removal cannot.
``causal``       future tokens cannot reach past positions (exact).
``padding``      padded notes cannot reach real ones (exact).
``loss``         `model_v2.head_losses` equals `train.py`'s at exactly 0.0. The function had
                 to be re-stated (train.py raises on import by design), and a re-stated loss
                 that drifts is a silent change of objective; the reference is lifted out of
                 train.py's source with `ast` so the comparison is against the shipped code.
``rope``         the rotary path is a genuine relative encoding, not just a tensor that runs.
``pedal_index``  the pedal column is 14 *in dataset.py's actual output*, re-derived by
                 running the extractor, and the check has teeth (a wrong index aborts).
                 Without this the exclusion is a docstring, and a re-preprocessed pack
                 reinstates the leak under a log line that still says EXCLUDED.
``config``       unknown keys, contradicted widths, a missing architecture key, a heads
                 request against a label-free pack and an unguarded pedal leak all abort.
``seed``         the run is reproducible from its own record: same seed -> identical weights
                 and an identical first-step loss end to end; batch order is a pure function
                 of (seed, epoch), so a resume replays the uninterrupted order.
``resume``       the resume guard covers the SCHEDULE, not only the architecture -- proved by
                 running `train_v2.main` against a written checkpoint, not by inspection.
``ckpt``         a checkpoint round-trips through `eval_ckpt_v2.load_checkpoint`, the decode
                 budget comes from the run's own record, and the config diff sees changes.
``decode``       `greedy_decode` keeps `model.py`'s contract (BOS, PAD after EOS).
``sizes``        the two shipped configs are the sizes they claim to be, and differ in the
                 four keys they claim to differ in and nothing else.
``gate``         `base.json`'s port gate matches the truthful re-eval in the tree, not the
                 superseded verdict-table figures.
"""

import ast
import contextlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

import torch
import torch.nn as nn

import model_v2 as m2
from model import TempoTransformer
from model_v2 import (PEDAL_FEATURE_INDEX, HybridTransformer, RotaryEmbedding, build_model,
                      head_losses, load_run_config, param_count, resolve_model_cfg,
                      seed_everything, state_dict_from_v1, verify_pedal_index)

CONFIGS = Path(__file__).with_name("configs")
#: the v4 verdict architecture, on the 16-feature v4.1 pack
BASE_KW = dict(d_model=192, nhead=8, enc_layers=4, dec_layers=4, ff=768,
               n_features=16, vocab_size=35)


def _rand_batch(b=3, n=11, t=7, f=16, vocab=35, seed=0):
    g = torch.Generator().manual_seed(seed)
    x = torch.randn(b, n, f, generator=g)
    xm = torch.zeros(b, n, dtype=torch.bool)
    xm[2, 8:] = True                      # one short piece, as the packer produces
    y = torch.randint(0, vocab, (b, t), generator=g)
    return x, xm, y


def _tiny_pack(n_pieces=6, t=9, seed=0):
    """A minimal v4.1-shaped pack: enough for `train_v2.main` to take real optimiser steps."""
    g = torch.Generator().manual_seed(seed)
    feats = [torch.randn(6 + i % 3, 16, generator=g) for i in range(n_pieces)]
    tgts = []
    for _ in feats:
        y = torch.randint(3, 35, (t,), generator=g)
        y[0], y[-1] = 1, 2                       # BOS ... EOS, as the packer writes them
        tgts.append(y)
    labels = [torch.rand(f.shape[0], 4, generator=g) for f in feats]
    return {"feats": feats, "tgts": tgts, "note_labels": labels, "max_tgt": t, "v4": True}


@contextlib.contextmanager
def _sandbox():
    """A throwaway cwd shaped like `ml/python` (so ``../runs`` and ``../data`` are its own),
    carrying a tiny v4.1 pack. Lets a check run `train_v2.main` end to end without touching
    the real runs directory."""
    td = Path(tempfile.mkdtemp())
    (td / "python").mkdir()
    (td / "runs").mkdir()
    (td / "data").mkdir()
    torch.save(_tiny_pack(), td / "data" / "train_v41.pt")
    torch.save(_tiny_pack(seed=1), td / "data" / "val_v41.pt")
    old = os.getcwd()
    os.chdir(td / "python")
    try:
        yield td
    finally:
        os.chdir(old)
        shutil.rmtree(td, ignore_errors=True)


def _smoke_argv(td, run, extra=()):
    """`train_v2` CLI for a 1-step run inside the sandbox (absolute paths: cwd is temporary).

    ``extra`` is flag/value pairs that REPLACE the defaults rather than being appended --
    `take_flag` consumes the first occurrence, so a repeated flag would leave the second as
    a stray positional.
    """
    flags = {"--config": str(CONFIGS / "base.json"), "--data": str(td / "data"),
             "--batch": "2", "--max-steps": "1"}
    it = iter(extra)
    for k in it:
        flags[k] = next(it)
    return ["1", run, "v41", *[s for kv in flags.items() for s in kv]]


# ---------------------------------------------------------------------------- equivalence
def check_equivalence():
    """base == model.py: same parameter count, and the same function once weights are moved."""
    torch.manual_seed(0)
    v1 = TempoTransformer(dropout=0.0, heads=True, **BASE_KW)
    v2 = HybridTransformer(dropout=0.0, heads=True, pos="sinusoidal", activation="relu",
                           exclude_features=(), **BASE_KW)
    n1, n2 = param_count(v1), param_count(v2)
    print(f"  params: model.py {n1} ({n1/1e6:.4f}M)   model_v2 {n2} ({n2/1e6:.4f}M)   "
          f"diff {n2 - n1}")
    assert n1 == n2, "base config must have exactly the v4 parameter count"
    shapes1 = sorted(tuple(p.shape) for p in v1.parameters())
    shapes2 = sorted(tuple(p.shape) for p in v2.parameters())
    assert shapes1 == shapes2, "parameter shape multisets differ"

    sd = state_dict_from_v1(v1.state_dict(), BASE_KW["enc_layers"], BASE_KW["dec_layers"])
    missing = v2.load_state_dict(sd, strict=True)
    assert not missing.missing_keys and not missing.unexpected_keys, missing
    print(f"  state dict: {len(sd)} tensors transplanted by rename, strict load clean")

    v1.eval(), v2.eval()
    x, xm, y = _rand_batch()
    with torch.no_grad():
        l1, h1 = v1(x, xm, y, return_heads=True)
        l2, h2 = v2(x, xm, y, return_heads=True)
    assert l1.shape == l2.shape == (3, 7, 35), (l1.shape, l2.shape)
    dl = float((l1 - l2).abs().max())
    dh = {k: float((h1[k] - h2[k]).abs().max()) for k in h1}
    scale = float(l1.abs().max())
    print(f"  forward: shapes {tuple(l2.shape)} match; max |logit diff| {dl:.3e} "
          f"(logit scale {scale:.3f}, relative {dl/scale:.2e})")
    print("  heads:   " + ", ".join(f"{k} {v:.3e}" for k, v in dh.items()))
    # NOT asserted at 0.0, and the difference is not a defect: F.scaled_dot_product_attention
    # and nn.MultiheadAttention reach the same result through different kernels and reduction
    # orders. What is asserted is that the gap is float32 rounding on this size of network,
    # not a structural difference -- a wrong residual order or a missing final norm lands
    # orders of magnitude above this.
    assert dl < 1e-4, f"transplanted forward differs by {dl}: that is not rounding"
    for k, v in dh.items():
        assert v < 1e-3, (k, v)
    for name, mdl in (("model.py", v1), ("model_v2", v2)):
        assert mdl.has_heads, name


# ------------------------------------------------------------------------------ f14 leak
def check_leak():
    """``exclude_features=[14]`` makes the output EXACTLY independent of the pedal column."""
    torch.manual_seed(1)
    kw = dict(BASE_KW, dropout=0.0, heads=True)
    excl = HybridTransformer(exclude_features=[PEDAL_FEATURE_INDEX], **kw)
    keep = HybridTransformer(exclude_features=(), **kw)
    print(f"  in_proj in_features: excluded {excl.in_proj[0].in_features}, "
          f"kept {keep.in_proj[0].in_features} (pack width {excl.n_features})")
    assert excl.in_proj[0].in_features == 15 and keep.in_proj[0].in_features == 16
    assert excl.n_features == 16, "n_features must stay the PACK width (eval_ckpt guard)"

    x, xm, y = _rand_batch(seed=7)
    x2 = x.clone()
    x2[..., PEDAL_FEATURE_INDEX] = torch.randn_like(x2[..., PEDAL_FEATURE_INDEX]) * 5.0
    excl.eval(), keep.eval()
    with torch.no_grad():
        a, ha = excl(x, xm, y, return_heads=True)
        b, hb = excl(x2, xm, y, return_heads=True)
        c = keep(x, xm, y)
        d = keep(x2, xm, y)
    d_excl = float((a - b).abs().max())
    d_keep = float((c - d).abs().max())
    d_head = max(float((ha[k] - hb[k]).abs().max()) for k in ha)
    print(f"  perturbing feature {PEDAL_FEATURE_INDEX}: excluded model moves {d_excl:.3e} "
          f"(logits) / {d_head:.3e} (heads); leaking model moves {d_keep:.3e}")
    assert d_excl == 0.0, "excluded feature still reaches the logits"
    assert d_head == 0.0, "excluded feature still reaches the per-note heads"
    assert d_keep > 0.0, "control failed: the leaking model ignores the feature too"

    # ... and gradients cannot flow back into it either, because the weight does not exist
    a = excl(x, xm, y)
    a.sum().backward()
    assert excl.in_proj[0].weight.grad.shape[1] == 15
    print("  gradient: in_proj weight has 15 input columns; there is no f14 weight to train")

    # the guard that keeps this on by default
    cfg = resolve_model_cfg({"model": {"exclude_features": []}}, "v41", heads=True)
    try:
        from train_v2 import check_pedal_leak
        check_pedal_leak({}, "v41", cfg, True)
        raise AssertionError("an unguarded pedal leak was allowed")
    except SystemExit as e:
        assert "pedal head is on" in str(e), e
    from train_v2 import check_pedal_leak
    assert check_pedal_leak({"allow_pedal_leak": True}, "v41", cfg, True).startswith("INPUT")
    ok = resolve_model_cfg({"model": {"exclude_features": [14]}}, "v41", heads=True)
    assert check_pedal_leak({}, "v41", ok, True) == "EXCLUDED (leak fix)"
    print("  train_v2 aborts on an unguarded leak, allows it with allow_pedal_leak=true")


# --------------------------------------------------------------------------- pedal index
def check_pedal_index():
    """f14 is the pedal column of `dataset.py`'s ACTUAL output, and the check has teeth.

    `PEDAL_FEATURE_INDEX` is a claim about another module's layout. Asserting it from a
    docstring is asserting it from a comment: if the corpus subsystem re-preprocesses to a
    new layout, the index silently points at some other feature, the pedal column is back in
    the input, and the startup line still reads ``f14_pedal=EXCLUDED``. So the extractor is
    run twice on one record -- pedal up, pedal down -- and the columns that move must be
    exactly [14].
    """
    for mode in ("v4", "v41"):
        print(f"  {mode}: {verify_pedal_index(mode)}")
    assert verify_pedal_index("v1") .startswith("n/a")

    # teeth: a wrong index must abort, or the check proves nothing
    for wrong in (13, 15):
        try:
            verify_pedal_index("v41", index=wrong)
            raise AssertionError(f"verify_pedal_index accepted the wrong index {wrong}")
        except SystemExit as e:
            assert "is wrong for mode" in str(e), e
    print("  control: indices 13 (part) and 15 (cross_part_offset) are both rejected")

    from train_v2 import check_pedal_leak
    cfg = resolve_model_cfg({"model": {"exclude_features": [PEDAL_FEATURE_INDEX]}},
                            "v41", heads=True)
    assert check_pedal_leak({}, "v41", cfg, True) == "EXCLUDED (leak fix)"
    print("  train_v2.check_pedal_leak re-proves the index on every run before it trains")
    assert m2.describe_exclusions([14]) == "[14:pedal_state]"
    print(f"  the startup line names the column it drops: "
          f"excl{m2.describe_exclusions([14])} (was 'feat=16-1excl')")


# -------------------------------------------------------------------------------- masking
def check_causal():
    """A token at position k must not see anything after it — exactly."""
    torch.manual_seed(2)
    mdl = HybridTransformer(dropout=0.0, **BASE_KW).eval()
    x, xm, y = _rand_batch(t=12, seed=3)
    y2 = y.clone()
    k = 5
    y2[:, k:] = torch.randint(0, 35, y2[:, k:].shape)
    with torch.no_grad():
        a = mdl(x, xm, y)
        b = mdl(x, xm, y2)
    past = float((a[:, :k] - b[:, :k]).abs().max())
    future = float((a[:, k:] - b[:, k:]).abs().max())
    print(f"  rewriting tokens from {k} on: positions <{k} move {past:.3e}, "
          f"positions >={k} move {future:.3e}")
    assert past == 0.0, "the causal mask leaks"
    assert future > 0.0, "control failed: the decoder ignores its own input"


def check_padding():
    """Padded notes must not reach real ones — exactly — in either direction."""
    torch.manual_seed(4)
    mdl = HybridTransformer(dropout=0.0, heads=True, **BASE_KW).eval()
    x, xm, y = _rand_batch(n=14, seed=5)
    xm[:, 10:] = True
    x2 = x.clone()
    x2[:, 10:] = torch.randn_like(x2[:, 10:]) * 3.0
    with torch.no_grad():
        a = mdl.encode(x, xm)
        b = mdl.encode(x2, xm)
        la, lb = mdl(x, xm, y), mdl(x2, xm, y)
    valid = float((a[:, :10] - b[:, :10]).abs().max())
    logit = float((la - lb).abs().max())
    print(f"  rewriting padded rows: valid encoder positions move {valid:.3e}, "
          f"logits move {logit:.3e}")
    assert valid == 0.0, "padding leaks into the encoder memory"
    assert logit == 0.0, "padding leaks through cross-attention into the logits"


# ----------------------------------------------------------------------------------- loss
def _train_py_head_losses():
    """Lift `head_losses` out of train.py's source without executing the module.

    train.py raises ImportError when imported (its body is a training run), so the only way
    to compare against the *shipped* function is to parse the file and compile that one
    definition. Anything else compares against a copy, which is what is under test.
    """
    src = Path(__file__).with_name("train.py").read_text()
    tree = ast.parse(src)
    fn = next(n for n in tree.body
              if isinstance(n, ast.FunctionDef) and n.name == "head_losses")
    mod = ast.fix_missing_locations(ast.Module(body=[fn], type_ignores=[]))
    ns = {"nn": nn, "VEL_CHANGE_SCALE": m2.VEL_CHANGE_SCALE, "PEDAL_SCALE": m2.PEDAL_SCALE}
    exec(compile(mod, "train.py", "exec"), ns)
    return ns["head_losses"]


def check_loss():
    ref = _train_py_head_losses()
    g = torch.Generator().manual_seed(11)
    worst = 0.0
    for trial, artic_rate in enumerate((0.15, 0.0, 1.0)):     # incl. the empty-mask branch
        b, n = 4, 9
        heads = {"artic_logit": torch.randn(b, n, generator=g),
                 "rel_dur": 1.0 + 0.2 * torch.randn(b, n, generator=g),
                 "vel_change": 16.0 * torch.randn(b, n, generator=g),
                 "pedal_state": 127.0 * torch.rand(b, n, generator=g)}
        lab = torch.stack([
            (torch.rand(b, n, generator=g) < artic_rate).float(),
            1.0 + 0.3 * torch.randn(b, n, generator=g),
            10.0 * torch.randn(b, n, generator=g),
            127.0 * torch.rand(b, n, generator=g)], dim=-1)
        valid = torch.ones(b, n, dtype=torch.bool)
        valid[3, 6:] = False
        got = head_losses(heads, lab, valid)
        want = ref(heads, lab, valid)
        d = max(float((a - b_).abs().max()) for a, b_ in zip(got, want))
        worst = max(worst, d)
        print(f"  artic_rate {artic_rate:.2f}: "
              + " ".join(f"{float(v):.6f}" for v in got) + f"   max|diff| {d:.3e}")
        assert all(torch.isfinite(v) for v in got), "a loss component is not finite"
    assert worst == 0.0, f"model_v2.head_losses drifted from train.py's by {worst}"
    print(f"  max |model_v2 - train.py| over 3 label regimes: {worst:.1e}")


# ----------------------------------------------------------------------------------- rope
def check_rope():
    """RoPE must make the attention logit a function of the offset alone."""
    torch.manual_seed(6)
    hd, t = 24, 16
    rope = RotaryEmbedding(hd, max_len=64)
    q0, k0 = torch.randn(hd), torch.randn(hd)
    q = q0.view(1, 1, 1, hd).expand(1, 1, t, hd).contiguous()
    k = k0.view(1, 1, 1, hd).expand(1, 1, t, hd).contiguous()
    a = (rope(q) @ rope(k).transpose(-1, -2))[0, 0]
    # constant along every diagonal <=> depends on (m - n) only
    off = max(float((a.diagonal(o) - a.diagonal(o)[0]).abs().max())
              for o in range(-t + 1, t))
    print(f"  logit constancy along diagonals (offset-only property): max dev {off:.3e}")
    assert off < 1e-4, "rope logits are not a function of the offset alone"
    # a rotation preserves norms
    dn = float((rope(q).norm(dim=-1) - q.norm(dim=-1)).abs().max())
    print(f"  norm preservation: max |dev| {dn:.3e}")
    assert dn < 1e-4

    mdl = HybridTransformer(dropout=0.0, heads=True, pos="rope", **BASE_KW)
    assert mdl.pos_enc is None and mdl.rope is not None
    x, xm, y = _rand_batch(seed=8)
    logits, hd_out = mdl(x, xm, y, return_heads=True)
    assert logits.shape == (3, 7, 35)
    assert torch.isfinite(logits).all() and all(torch.isfinite(v).all()
                                                for v in hd_out.values())
    logits.sum().backward()
    grads = [p.grad for p in mdl.parameters() if p.grad is not None]
    print(f"  rope model: params {param_count(mdl)/1e6:.4f}M (vs sinusoidal "
          f"{param_count(HybridTransformer(dropout=0.0, heads=True, **BASE_KW))/1e6:.4f}M, "
          f"rope is parameter-free), {len(grads)} tensors got gradients")
    assert all(torch.isfinite(g).all() for g in grads)
    # sanity: rope must actually change the function (a no-op would also pass the above)
    torch.manual_seed(6)
    sin_m = HybridTransformer(dropout=0.0, **BASE_KW).eval()
    torch.manual_seed(6)
    rope_m = HybridTransformer(dropout=0.0, pos="rope", **BASE_KW).eval()
    with torch.no_grad():
        d = float((sin_m(x, xm, y) - rope_m(x, xm, y)).abs().max())
    print(f"  sinusoidal vs rope on identical seeds: max |diff| {d:.3e} (must be > 0)")
    assert d > 0.0


# --------------------------------------------------------------------------------- config
def check_config():
    """The shipped configs load, and every way of lying to the config aborts."""
    for name in ("base", "large"):
        cfg = load_run_config(CONFIGS / f"{name}.json")
        rc = resolve_model_cfg(cfg, cfg["mode"], heads=True)
        print(f"  {name}.json: mode={cfg['mode']} -> n_features={rc['n_features']} "
              f"vocab={rc['vocab_size']} exclude={rc['exclude_features']} "
              f"pos={rc['pos']} act={rc['activation']}")
        assert rc["n_features"] == 16 and rc["vocab_size"] == 35
        assert rc["exclude_features"] == [PEDAL_FEATURE_INDEX]

    def aborts(fn, needle):
        try:
            fn()
        except SystemExit as e:
            assert needle in str(e), f"wrong abort message: {e}"
            return str(e).splitlines()[0][:96]
        raise AssertionError(f"expected an abort mentioning {needle!r}")

    with tempfile.TemporaryDirectory() as td:
        bad = Path(td) / "bad.json"
        bad.write_text(json.dumps({"mode": "v41", "model": {"d_modell": 192}}))
        print("  " + aborts(lambda: load_run_config(bad), "unknown key"))
        bad.write_text(json.dumps({"mode": "v41", "arch": "model.py"}))
        print("  " + aborts(lambda: load_run_config(bad), "declares arch"))
        # an OMITTED key used to default in silence, which is the same defect as a defaulted
        # architecture one level down: `{"model": {}}` built d192 4+4 ff768 without a word
        bad.write_text(json.dumps({"mode": "v41", "model": {}}))
        print("  " + aborts(lambda: load_run_config(bad), "does not state"))
        full = {k: v for k, v in json.loads((CONFIGS / "base.json").read_text()).items()}
        del full["model"]["ff"]
        bad.write_text(json.dumps(full))
        print("  " + aborts(lambda: load_run_config(bad), "['ff']"))
    # the keys that DO default, default loudly: train_v2 prints exactly this dict
    dk = m2.defaulted_keys({"d_model": 192}, m2.MODEL_DEFAULTS)
    assert set(dk) == set(m2.MODEL_DEFAULTS), dk
    assert m2.defaulted_keys(load_run_config(CONFIGS / "base.json")["model"],
                             m2.MODEL_DEFAULTS) == {}
    print(f"  documented defaults are reported, not silent: a bare model block takes "
          f"{sorted(dk)}; base.json takes none")
    print("  " + aborts(
        lambda: resolve_model_cfg({"model": {"n_features": 15}}, "v41", heads=True),
        "but mode v41 is 16"))
    try:
        HybridTransformer(exclude_features=[99], **BASE_KW)
        raise AssertionError("out-of-range exclude_features accepted")
    except ValueError as e:
        assert "out of range" in str(e), e
    print("  out-of-range exclude_features rejected at construction")

    from train_v2 import resolve_heads
    assert resolve_heads({"model": {"heads": True}}, "v41",
                         {"note_labels": [1]}) == (True, "config")
    assert resolve_heads({"model": {"heads": False}}, "v41",
                         {"note_labels": [1]}) == (False, "config")
    assert resolve_heads({}, "v41", {"note_labels": [1]})[0] is True
    assert resolve_heads({}, "v41", {})[0] is False
    print("  " + aborts(lambda: resolve_heads({"model": {"heads": True}}, "v41", {}),
                        "carries no `note_labels`"))

    # a model built with a v4 config must refuse a v4.1 pack rather than broadcast it
    mdl = HybridTransformer(**dict(BASE_KW, n_features=15)).eval()
    try:
        mdl(torch.randn(1, 4, 16), torch.zeros(1, 4, dtype=torch.bool),
            torch.zeros(1, 3, dtype=torch.long))
        raise AssertionError("a 15-feature model accepted a 16-feature batch")
    except ValueError as e:
        assert "expects 15 features" in str(e), e
    print("  a 15-feature model refuses a 16-feature batch")


# ----------------------------------------------------------------------------------- seed
def _first_loss(log_path):
    """The step-1 ``loss`` and head components as WRITTEN -- string equality, not float."""
    line = next(l for l in Path(log_path).read_text().splitlines() if " step 1/" in l)
    return line.split("] ", 1)[1].split(" (")[0]


def check_seed():
    """Same seed -> the same run. Different seed -> a different one.

    `--config` is mandatory because "a defaulted architecture is a run that cannot be
    reproduced from its own record" -- but weight init was unseeded, so a v2 run could not be
    reproduced from its record either. Three runs of one smoke command gave three different
    step-1 losses (3.6389 / 3.6895 / 3.7150 in the record). This is that hole closed, and the
    floor is exact: the two logs must agree character for character.
    """
    assert "seed" in m2.TRAIN_KEYS
    from train_v2 import DEFAULT_TRAIN, effective_train_cfg, epoch_order, main
    assert DEFAULT_TRAIN["seed"] == 0
    for name in ("base", "large"):
        assert load_run_config(CONFIGS / f"{name}.json")["train"]["seed"] == 0

    seed_everything(3)
    a = build_model(resolve_model_cfg({}, "v41", heads=True)).state_dict()
    seed_everything(3)
    b = build_model(resolve_model_cfg({}, "v41", heads=True)).state_dict()
    seed_everything(4)
    c = build_model(resolve_model_cfg({}, "v41", heads=True)).state_dict()
    same = max(float((a[k] - b[k]).abs().max()) for k in a)
    diff = max(float((a[k] - c[k]).abs().max()) for k in a)
    print(f"  weight init: seed 3 twice -> max |diff| {same}; seed 3 vs 4 -> {diff:.3f}")
    assert same == 0.0 and diff > 0.0

    # batch order is a pure function of (seed, epoch): the property a resume needs
    bs = [[i] for i in range(24)]
    assert epoch_order(bs, 0, 5) == epoch_order(bs, 0, 5)
    assert epoch_order(bs, 0, 5) != epoch_order(bs, 0, 6)
    assert epoch_order(bs, 0, 5) != epoch_order(bs, 1, 5)
    assert bs == [[i] for i in range(24)], "epoch_order mutated the canonical list"
    out_of_order = [epoch_order(bs, 0, e) for e in (7, 5, 6)]
    assert out_of_order[1] == epoch_order(bs, 0, 5)
    print("  batch order: pure in (seed, epoch), independent of call history, non-mutating")

    # ... and end to end: one step of the real trainer, twice, byte-identical logs
    losses = []
    for seed in ("0", "0", "1"):
        with _sandbox() as td:
            main(_smoke_argv(td, f"seed-{seed}", ("--seed", seed)))
            losses.append(_first_loss(td / "runs" / f"seed-{seed}" / "log.txt"))
    print(f"  train_v2 step 1, seed 0: {losses[0]!r}")
    print(f"  train_v2 step 1, seed 0: {losses[1]!r}")
    print(f"  train_v2 step 1, seed 1: {losses[2]!r}")
    assert losses[0] == losses[1], "two runs of one seeded command differ"
    assert losses[0] != losses[2], "control failed: the seed does not reach the run"


# --------------------------------------------------------------------------------- resume
def check_resume():
    """The resume guard covers the schedule, not only the architecture.

    It used to diff the resolved MODEL config alone, so resuming a run with a different
    ``--batch`` was accepted silently -- and ``batch`` sets ``len(batches)``, hence
    ``total_steps`` and ``step = start_epoch * len(batches)``: the cosine schedule restarts
    somewhere the original run never was, under the original run's name. Proved by RUNNING
    `train_v2.main` against a written checkpoint; an inspection of the source would pass
    equally well if nothing called the guard.
    """
    from train_v2 import (EVAL_KEYS, SCHEDULE_KEYS, config_diff, effective_train_cfg, main)
    run_cfg = load_run_config(CONFIGS / "base.json")
    assert set(SCHEDULE_KEYS) & set(EVAL_KEYS) == set()
    assert set(SCHEDULE_KEYS) | set(EVAL_KEYS) == m2.TRAIN_KEYS, "a train key is unguarded"
    print(f"  every train key is classified: schedule={list(SCHEDULE_KEYS)} "
          f"eval={list(EVAL_KEYS)}")

    def write_ckpt(td, run, overrides):
        cfg = resolve_model_cfg(run_cfg, "v41", heads=True)
        tcfg = effective_train_cfg(run_cfg, dict({"epochs": 1, "batch": 2}, **overrides))
        d = td / "runs" / run
        d.mkdir(parents=True, exist_ok=True)
        torch.save({"model": build_model(cfg).state_dict(), "epoch": 0, "config": cfg,
                    "arch": "model_v2", "mode": "v41", "train_config": tcfg,
                    "seed": tcfg["seed"], "max_decode": 9}, d / "ckpt.pt")
        return d

    def aborts(fn, needle):
        try:
            fn()
        except SystemExit as e:
            assert needle in str(e), f"wrong abort: {e}"
            return str(e)[:150]
        raise AssertionError(f"expected an abort mentioning {needle!r}")

    with _sandbox() as td:
        write_ckpt(td, "r-ok", {})
        main(_smoke_argv(td, "r-ok"))
        assert "resuming r-ok from epoch 1" in (td / "runs" / "r-ok" / "log.txt").read_text()
        print("  matching schedule -> resumes")

        write_ckpt(td, "r-batch", {})
        print("  " + aborts(lambda: main(_smoke_argv(td, "r-batch", ("--batch", "3"))),
                            "training schedule differs"))
        write_ckpt(td, "r-seed", {})
        print("  " + aborts(lambda: main(_smoke_argv(td, "r-seed", ("--seed", "7"))),
                            "seed: ckpt=0 now=7"))
        write_ckpt(td, "r-hw", {})
        print("  " + aborts(lambda: main(_smoke_argv(td, "r-hw", ("--head-weight", "0.5"))),
                            "head_weight"))

        # a checkpoint from the architecture-only build cannot testify about its schedule
        d = write_ckpt(td, "r-old", {})
        ck = torch.load(d / "ckpt.pt", weights_only=False)
        del ck["train_config"]
        torch.save(ck, d / "ckpt.pt")
        print("  " + aborts(lambda: main(_smoke_argv(td, "r-old")), "no `train_config`"))

    # eval-only keys are reported, not refused: they change what is measured, not the weights
    tc = effective_train_cfg(run_cfg)
    assert config_diff(tc, dict(tc, eval_pieces=20), SCHEDULE_KEYS) == {}
    assert config_diff(tc, dict(tc, eval_pieces=20), EVAL_KEYS) == {"eval_pieces": (100, 20)}
    print("  eval_pieces/eval_every/decode_batch changes are logged on resume, not refused")


# ----------------------------------------------------------------------------- checkpoints
def check_ckpt():
    """A checkpoint round-trips through the eval adapter; the resume guard sees changes."""
    from eval_ckpt_v2 import load_checkpoint, resolve_max_decode
    from train_v2 import config_diff

    cfg = resolve_model_cfg(load_run_config(CONFIGS / "base.json"), "v41", heads=True)
    mdl = build_model(cfg)
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "ckpt.pt"
        torch.save({"model": mdl.state_dict(), "epoch": 3, "config": cfg,
                    "arch": "model_v2", "mode": "v41", "max_decode": 512, "seed": 0}, p)
        fake_val = {"feats": [torch.zeros(4, 16)], "v4": True}
        got, got_cfg, epoch, rec = load_checkpoint(p, fake_val, torch.device("cpu"))
        assert epoch == 3 and got_cfg == cfg and rec["max_decode"] == 512
        same = max(float((a - b).abs().max())
                   for a, b in zip(got.state_dict().values(), mdl.state_dict().values()))
        print(f"  round-trip through eval_ckpt_v2.load_checkpoint: max |weight diff| {same}")
        assert same == 0.0

        # the decode budget is the RUN's, not a table's. eval_ckpt.py's table says 320 for
        # v4 and has no v41 key; scoring a 512-budget run at 320 is not a re-score of it.
        md, why, warn = resolve_max_decode(rec, fake_val, "v4")
        assert (md, warn) == (512, None) and why.startswith("checkpoint")
        md2, why2, _ = resolve_max_decode({}, dict(fake_val, max_tgt=444), "v4")
        assert (md2, why2.split()[0]) == (444, "pack")
        md3, why3, warn3 = resolve_max_decode({}, fake_val, "v4")
        assert md3 == m2.MODE_MAX_DECODE["v4"] == 512 and "eval_ckpt.py" in warn3
        _, _, warn4 = resolve_max_decode(rec, dict(fake_val, max_tgt=600), "v4")
        assert warn4 and "truncat" not in warn4.lower() and "600" in warn4
        print(f"  max_decode: ckpt 512 [{why.split('(')[0].strip()}] > pack max_tgt 444 > "
              f"table {md3}; a pack needing 600 warns instead of silently rescaling")

        # a pack of the wrong width aborts instead of broadcasting
        try:
            load_checkpoint(p, {"feats": [torch.zeros(4, 15)], "v4": True},
                            torch.device("cpu"))
            raise AssertionError("wrong feature width accepted")
        except SystemExit as e:
            assert "n_features" in str(e)
        # a pre-v2 checkpoint is refused by the adapter
        torch.save({"model": {}, "config": {"d_model": 192}}, p)
        try:
            load_checkpoint(p, fake_val, torch.device("cpu"))
            raise AssertionError("a pre-v2 checkpoint was accepted")
        except SystemExit as e:
            assert "declares arch" in str(e)
    print("  wrong-width pack and pre-v2 checkpoint both abort")

    changed = dict(cfg, d_model=256)
    diff = config_diff(cfg, changed)
    assert set(diff) == {"d_model"} and diff["d_model"] == (192, 256)
    assert config_diff(cfg, dict(cfg)) == {}
    dropped = {k: v for k, v in cfg.items() if k != "heads"}
    assert "heads" in config_diff(dropped, cfg), "an absent key must count as a difference"
    print(f"  resume guard: identical config -> no diff; d_model change -> {diff}; "
          f"absent key counts as a difference")


# --------------------------------------------------------------------------------- decode
def check_decode():
    """`greedy_decode` keeps model.py's contract: BOS first, PAD after EOS, early break."""
    torch.manual_seed(9)
    mdl = HybridTransformer(dropout=0.0, **BASE_KW)
    x, xm, _ = _rand_batch(seed=12)
    ys = mdl.greedy_decode(x, xm, max_len=20)
    print(f"  shape {tuple(ys.shape)} (<= max_len 20), first column {ys[:, 0].tolist()}")
    assert ys.shape[0] == 3 and ys.shape[1] <= 20
    assert (ys[:, 0] == 1).all(), "greedy_decode must start at BOS"
    for row in ys.tolist():
        if 2 in row[1:]:
            after = row[row.index(2, 1) + 1:]
            assert set(after) <= {0}, f"non-PAD token after EOS: {row}"
    # forcing EOS makes every sequence stop at length 2
    with torch.no_grad():
        mdl.head.bias.zero_()
        mdl.head.bias[2] = 1e4
    ys = mdl.greedy_decode(x, xm, max_len=20)
    print(f"  with EOS forced: shape {tuple(ys.shape)} = BOS + EOS, early break works")
    assert ys.shape[1] == 2 and (ys[:, 1] == 2).all()


# ---------------------------------------------------------------------------------- sizes
def check_sizes():
    """The shipped configs are the sizes they claim, and differ only where they claim to.

    ``large`` vs ``base`` is only a scale comparison if everything else is held fixed, so
    the claim is asserted over THREE surfaces, not one: the resolved model kwargs (the four
    architecture keys), the `train` block (equal key for key, comments included -- the report
    once said "byte-identical" while the two `_schedule` strings differed), and the remaining
    top-level keys.
    """
    rows = []
    for name, lo, hi in (("base", 4.0e6, 4.6e6), ("large", 40e6, 50e6)):
        run = load_run_config(CONFIGS / f"{name}.json")
        cfg = resolve_model_cfg(run, run["mode"], heads=True)
        mdl = build_model(cfg)
        n = param_count(mdl)
        rows.append((name, run, cfg, n))
        print(f"  {name:<6} {m2.describe(cfg, mdl)}")
        assert lo <= n <= hi, f"{name}: {n/1e6:.2f}M outside [{lo/1e6}, {hi/1e6}]M"
    (_, brun, bc, b), (_, lrun, lc, l) = rows

    moved = {k for k in set(bc) | set(lc) if bc.get(k) != lc.get(k)}
    assert moved == {"d_model", "enc_layers", "dec_layers", "ff"}, moved
    print(f"  large / base = {l/b:.1f}x parameters; resolved model kwargs differ in "
          + ", ".join(sorted(moved)) + " and nothing else")

    tdiff = {k for k in set(brun["train"]) | set(lrun["train"])
             if brun["train"].get(k) != lrun["train"].get(k)}
    assert brun["train"] == lrun["train"], f"train blocks differ in {sorted(tdiff)}"
    print(f"  train blocks: identical key for key, comments included "
          f"({len(brun['train'])} keys incl. {sum(1 for k in brun['train'] if k[0]=='_')} "
          f"comment key(s)) -- one variable")

    top = {k for k in set(brun) | set(lrun)
           if not k.startswith("_") and k not in ("name", "note", "model", "train")
           and brun.get(k) != lrun.get(k)}
    assert top == set(), f"top-level keys differ: {sorted(top)}"
    mdiff = {k for k in set(brun["model"]) | set(lrun["model"])
             if not k.startswith("_") and brun["model"].get(k) != lrun["model"].get(k)}
    assert mdiff == moved, mdiff
    print(f"  raw model blocks differ in {sorted(mdiff)}; arch/mode identical; only `name`, "
          f"`note` and the '_'-prefixed comments are free to differ")


# ----------------------------------------------------------------------------------- gate
def check_gate():
    """`base.json`'s port gate is the truthful re-eval, not the superseded verdict table.

    The v4-VERDICT table (LOG.md 19:45) reported v41-asyn-h100 at 771.6 ms render / 6.28 vel
    / 5.6 ms asyn. The truthful re-eval of the SAME checkpoint on the SAME pack -- the one
    LOG.md's five-run table adopts -- is 635.4 / 5.63 / 7.25. A v2-base run landing near
    700 ms reads as "port clean" against the first and as a port defect against the record,
    which is the whole purpose of a gate inverted. This check asserts the config's numbers
    against the file they came from, whenever that file is present (ml/runs/ is gitignored:
    present in the cluster workspace, absent in a fresh clone).
    """
    raw = json.loads((CONFIGS / "base.json").read_text())
    gate = raw["_gate"]
    for stale in ("771.6", "6.28", "5.6 ms"):
        assert stale not in raw["note"], f"base.json's note still cites {stale} as the gate"
    print(f"  gate cites run {gate['run']} via {gate['evaluator']}")
    assert "final_val.fixed.json" in gate["source"]

    # `source` is written the way every other path in a run config is: relative to ml/python,
    # the directory train_v2.py runs from
    src = (CONFIGS.parent / gate["source"]).resolve()
    if not src.exists():
        print(f"  SKIP the numeric comparison: {src} is absent (ml/runs/ is gitignored). "
              f"The config's declared values are "
              + ", ".join(f"{k} {gate[k]}" for k in ("render_rmse", "vel_rmse",
                                                     "asyn_offset_err", "artic_note_f1")))
        return
    got = json.loads(src.read_text())
    meta = got.get("_meta", {})
    print(f"  {src.name}: epoch {meta.get('epoch')} n_pieces {meta.get('n_pieces')} "
          f"evaluator {meta.get('evaluator')}")
    for k in ("render_rmse", "vel_rmse", "asyn_offset_err", "artic_note_f1", "boundary_f1"):
        want, have = float(gate[k]), float(got[k])
        # the config states the rounded figure the log and the report quote
        tol = 0.5 * 10 ** -len(str(want).split(".")[1].rstrip("0") or "0")
        print(f"    {k:<18} config {want:<8} file {have:<20.6f} |diff| {abs(want-have):.4f}")
        assert abs(want - have) <= max(tol, 0.006), f"{k}: config {want} vs file {have}"
    assert "pedal" not in {k.lower() for k in gate if not k.startswith("_")}
    print("  pedal_state_mae is deliberately absent from the gate: the f14 fix changed what "
          "it measures, so the v4 figure is not a target")


CHECKS = {"equivalence": check_equivalence, "leak": check_leak,
          "pedal_index": check_pedal_index, "causal": check_causal,
          "padding": check_padding, "loss": check_loss, "rope": check_rope,
          "config": check_config, "seed": check_seed, "resume": check_resume,
          "ckpt": check_ckpt, "decode": check_decode, "sizes": check_sizes,
          "gate": check_gate}


def main(argv):
    names = argv or list(CHECKS)
    bad = [n for n in names if n not in CHECKS]
    if bad:
        raise SystemExit(f"unknown check(s) {bad}; known: {list(CHECKS)}")
    failed = []
    for name in names:
        print(f"\n== {name} " + "=" * (70 - len(name)))
        try:
            CHECKS[name]()
            print(f"-- {name.upper()}_PASS")
        except Exception as e:            # noqa: BLE001 - a runner reports, it does not raise
            failed.append(name)
            print(f"-- {name.upper()}_FAIL: {type(e).__name__}: {e}")
    print("\n" + "=" * 78)
    if failed:
        print(f"FAILED {len(failed)}/{len(names)}: {failed}")
        return 1
    print(f"ALL_PASS ({len(names)}/{len(names)}): {list(names)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
