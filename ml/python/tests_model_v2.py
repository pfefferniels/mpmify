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
``config``       unknown keys, contradicted widths, a heads request against a label-free
                 pack and an unguarded pedal leak all abort.
``ckpt``         a checkpoint round-trips through `eval_ckpt_v2.load_checkpoint` and the
                 resume guard rejects a changed config.
``decode``       `greedy_decode` keeps `model.py`'s contract (BOS, PAD after EOS).
``sizes``        the two shipped configs are the sizes they claim to be.
"""

import ast
import json
import sys
import tempfile
from pathlib import Path

import torch
import torch.nn as nn

import model_v2 as m2
from model import TempoTransformer
from model_v2 import (PEDAL_FEATURE_INDEX, HybridTransformer, RotaryEmbedding, build_model,
                      head_losses, load_run_config, param_count, resolve_model_cfg,
                      state_dict_from_v1)

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


# ----------------------------------------------------------------------------- checkpoints
def check_ckpt():
    """A checkpoint round-trips through the eval adapter; the resume guard sees changes."""
    from eval_ckpt_v2 import load_checkpoint
    from train_v2 import config_diff

    cfg = resolve_model_cfg(load_run_config(CONFIGS / "base.json"), "v41", heads=True)
    mdl = build_model(cfg)
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "ckpt.pt"
        torch.save({"model": mdl.state_dict(), "epoch": 3, "config": cfg,
                    "arch": "model_v2", "mode": "v41"}, p)
        fake_val = {"feats": [torch.zeros(4, 16)], "v4": True}
        got, got_cfg, epoch = load_checkpoint(p, fake_val, torch.device("cpu"))
        assert epoch == 3 and got_cfg == cfg
        same = max(float((a - b).abs().max())
                   for a, b in zip(got.state_dict().values(), mdl.state_dict().values()))
        print(f"  round-trip through eval_ckpt_v2.load_checkpoint: max |weight diff| {same}")
        assert same == 0.0

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
    """The shipped configs are the sizes they claim."""
    rows = []
    for name, lo, hi in (("base", 4.0e6, 4.6e6), ("large", 40e6, 50e6)):
        run = load_run_config(CONFIGS / f"{name}.json")
        cfg = resolve_model_cfg(run, run["mode"], heads=True)
        mdl = build_model(cfg)
        n = param_count(mdl)
        rows.append((name, cfg, n))
        print(f"  {name:<6} {m2.describe(cfg, mdl)}")
        assert lo <= n <= hi, f"{name}: {n/1e6:.2f}M outside [{lo/1e6}, {hi/1e6}]M"
    (bn, bc, b), (ln, lc, l) = rows
    print(f"  large / base = {l/b:.1f}x parameters; the only config differences are "
          + ", ".join(k for k in bc if bc[k] != lc[k]))
    assert {k for k in bc if bc[k] != lc[k]} == {"d_model", "enc_layers", "dec_layers", "ff"}


CHECKS = {"equivalence": check_equivalence, "leak": check_leak, "causal": check_causal,
          "padding": check_padding, "loss": check_loss, "rope": check_rope,
          "config": check_config, "ckpt": check_ckpt, "decode": check_decode,
          "sizes": check_sizes}


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
