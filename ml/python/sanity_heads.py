"""Acceptance checks for the v4 per-note heads (LOG.md, hybrid phase 2).

Two independent things can be wrong with a head, and they fail in ways that look alike from
a training curve, so they are checked apart:

``python3 sanity_heads.py model``
    The *module* contract. A ``heads=True`` model round-trips its own state dict; a
    ``heads=False`` model has no head parameters at all and still loads a pre-heads
    checkpoint; and splitting ``nn.Transformer`` into an encoder call plus a decoder call
    (what ``forward`` now does, so a heads run pays for one encoder pass and not two) is
    numerically identical to the fused call it replaced.

``python3 sanity_heads.py assembly [n_pieces]``
    The *plumbing* contract, and the one worth having. Ground-truth note labels are pushed
    through the exact path a model's predictions take -- assemble a part-local
    articulationMap, hand it to ``evaluate_piece_v4``, render through ``PerfChainV4`` -- and
    the result must land on the evaluator's zero floor while the same render *without* the
    articulation must not. That separates "the head predicts badly" from "the head's output
    never reached the renderer", which is the failure a training run cannot distinguish.
"""

import statistics
import sys

import torch

MAPS = ("tempo", "dynamics", "articulation", "rubato", "movement", "asynchrony")
#: everything except articulation: the assembled map is the only thing under test
NON_ARTIC = tuple(m for m in MAPS if m != "articulation")


def _records(path, n):
    val = torch.load(path)
    for i in range(min(n, len(val["feats"]))):
        rec = {"notes": val["notes"][i].tolist()}
        for k in MAPS + ("total_ticks", "sustain_cc"):
            rec[k] = val[k][i]
        yield rec


def check_model():
    from model import TempoTransformer

    cfg = {"d_model": 64, "nhead": 4, "enc_layers": 2, "dec_layers": 2, "ff": 128,
           "n_features": 15, "vocab_size": 35}
    torch.manual_seed(0)
    plain = TempoTransformer(dropout=0.0, **cfg)
    heads = TempoTransformer(dropout=0.0, heads=True, **cfg)
    n_plain = sum(p.numel() for p in plain.parameters())
    n_heads = sum(p.numel() for p in heads.parameters())
    print(f"params: heads=False {n_plain}, heads=True {n_heads} "
          f"(+{n_heads - n_plain} = 2-layer trunk + 4-wide readout)")
    assert not plain.has_heads and heads.has_heads

    # a pre-heads checkpoint loads into a heads=False model unchanged, strictly
    missing, unexpected = plain.load_state_dict(plain.state_dict(), strict=True), None
    assert not missing.missing_keys and not missing.unexpected_keys, missing
    # ... and a heads model round-trips its own
    fresh = TempoTransformer(dropout=0.0, heads=True, **cfg)
    r = fresh.load_state_dict(heads.state_dict(), strict=True)
    assert not r.missing_keys and not r.unexpected_keys, r
    # ... while the pre-heads dict is REFUSED by a heads model rather than silently padded
    try:
        fresh.load_state_dict(plain.state_dict(), strict=True)
        raise AssertionError("a heads model accepted a pre-heads state dict")
    except RuntimeError as e:
        assert "note_mlp" in str(e), e
    print("state dict: heads round-trips; pre-heads dict loads into heads=False and is "
          "refused by heads=True")

    # the split forward must equal the nn.Transformer call it replaced, exactly
    heads.eval()
    x = torch.randn(3, 11, 15)
    xm = torch.zeros(3, 11, dtype=torch.bool)
    xm[2, 8:] = True
    y = torch.randint(0, 35, (3, 7))
    with torch.no_grad():
        got, hd = heads(x, xm, y, return_heads=True)
        src = heads.pos_enc(heads.in_proj(x))
        tgt = heads.pos_dec(heads.tok_emb(y))
        causal = torch.nn.Transformer.generate_square_subsequent_mask(y.shape[1])
        want = heads.head(heads.transformer(src, tgt, tgt_mask=causal,
                                            src_key_padding_mask=xm,
                                            memory_key_padding_mask=xm))
    print(f"forward split vs fused nn.Transformer: max |diff| = "
          f"{float((got - want).abs().max()):.3e}")
    assert torch.equal(got, want)
    for k, v in hd.items():
        assert v.shape == (3, 11), (k, v.shape)
        assert torch.isfinite(v).all(), k
    print(f"note_heads: keys {sorted(hd)}, shapes (B,N) ok, all finite; "
          f"pedal range [{float(hd['pedal_state'].min()):.1f}, "
          f"{float(hd['pedal_state'].max()):.1f}] cc")
    print("MODEL_SANITY_PASS")


def check_assembly(path="../data/val_v4.pt", n=50):
    from dataset import piece_to_note_labels_v4
    from evaluate import evaluate_piece_v4, note_preds_to_articulation

    rows = {"render_rmse": ([], []), "off_rmse": ([], []), "vel_rmse": ([], [])}
    f1s, maes, exact_maps, n_pieces, n_artic = [], [], 0, 0, 0
    for rec in _records(path, n):
        gt = piece_to_note_labels_v4(rec)
        note_pred = {"artic_present": gt["artic_present"],
                     "rel_dur": gt["relative_duration"],
                     "vel_change": gt["velocity_change"],
                     "pedal_state": gt["pedal_state"]}
        base_maps = {k: rec[k] for k in NON_ARTIC}
        with_ = evaluate_piece_v4(base_maps, rec, note_pred=note_pred)
        without = evaluate_piece_v4(base_maps, rec)
        for k, (a, b) in rows.items():
            a.append(with_[k])
            b.append(without[k])
        f1s.append(with_["artic_note_f1"])
        maes.append(with_["pedal_state_mae"])
        n_pieces += 1
        n_artic += with_["n_artic_gt"]
        # the assembled map should not merely render the same -- on A6 data it should BE
        # the ground-truth map, up to rows meico drops (dates past a part's last note)
        got = note_preds_to_articulation(rec, note_pred)
        want = [list(r) for r in (rec["articulation"] or [])]
        exact_maps += int([[round(v, 9) for v in r] for r in got]
                          == [[round(float(v), 9) for v in r] for r in want])

    def med(v):
        return statistics.median(v)

    print(f"pieces {n_pieces}, ground-truth articulated notes {n_artic}")
    print(f"assembled map identical to the GT articulationMap: {exact_maps}/{n_pieces}")
    print(f"artic note F1 (min over pieces) {min(f1s):.4f}   "
          f"pedal_state MAE (max over pieces) {max(maes):.4f} cc")
    print(f"{'metric':<12} {'with heads':>14} {'no articulation':>17} {'lower on':>10}")
    for k, (a, b) in rows.items():
        lower = sum(1 for x, y in zip(a, b) if x < y)
        print(f"{k:<12} {med(a):>14.4f} {med(b):>17.4f} {lower:>7}/{n_pieces}")

    assert min(f1s) == 1.0, "articulation F1 must be 1.0 by construction on GT labels"
    assert max(maes) == 0.0, "pedal MAE must be 0.0 by construction on GT labels"
    assert exact_maps == n_pieces, "assembled map differs from the GT articulationMap"
    # velocity and note-off are the two render-space quantities articulation can move
    # (ArticulationData.articulateNote scales duration.perf and shifts velocity; it never
    # touches the onset, so render_rmse is expected to be identical, not lower)
    for k in ("off_rmse", "vel_rmse"):
        a, b = rows[k]
        assert all(x <= y for x, y in zip(a, b)), k
        assert sum(1 for x, y in zip(a, b) if x < y) > 0, f"{k} never improved"
        assert med(a) < med(b), f"{k} median not strictly lower"
    assert max(rows["render_rmse"][0]) == 0.0, "GT maps must render onsets exactly"
    print("ASSEMBLY_SANITY_PASS")


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "model"
    if what == "model":
        check_model()
    elif what == "assembly":
        check_assembly(n=int(sys.argv[2]) if len(sys.argv) > 2 else 50)
    else:
        raise SystemExit(__doc__)
