"""Prediction-only v4/v41 inference on records WITHOUT ground-truth MPM (real data).

Usage: python3 infer_v4.py --ckpt <ckpt.pt> <data.jsonl> [--limit N] [--out preds.json]
                           [--device cpu|cuda] [--id ID[,ID...]] [--dump-maps]

Thin driver over the SAME machinery training uses — no re-implementation:
features via dataset.piece_to_features_v4/_v41 (chosen by the checkpoint's n_features),
decoding via dsl.decode_piece_v4, head readout via model.note_heads, scoring via
evaluate.evaluate_piece_v4 (fixed re-keyed renderer, head-assembled articulation,
baselines, pedal-state MAE against the record's own sustain_cc). On records without
GT maps (Vienna), the GT-comparative outputs (F1s, mdl ratios) are meaningless and
dropped from the report; render/vel/pedal metrics need no GT MPM and are the point.

`--id` restricts the run to named record ids (comma-separated, compared as strings), and
`--dump-maps` writes, per surviving record, everything a downstream artifact needs to be
reproduced from this file alone and nothing that is re-derived on the way there:

    maps           the decoder's own output (`dsl.decode_piece_v4`), 6 map keys
    maps_rendered  the map dict `evaluate_piece_v4` ACTUALLY rendered: `maps` plus the
                   head-assembled part-local articulationMap and the date-0 tempo/dynamics
                   fallbacks. Written because the emitted MPM and the rendered curve must
                   be the same object -- and checked, not asserted by comment: re-rendering
                   it here must reproduce `render_rmse`/`vel_rmse` *bit for bit* or the run
                   aborts (`--dump-maps` re-render check), so this dict cannot silently
                   drift from what the evaluator scored.
    note_pred      the four per-note head outputs, in `evaluate._v4_note_order`
    notes          the record's own note rows (score ticks, dur, pitch, ms_on, ms_off, vel, part)
    render         pred/baseline rendered onsets, offsets and velocities in record note
                   order (`null` for a row the chain produced no note for), plus the
                   baseline's constant tempo map
    meta           the record's provenance fields (`META_KEYS`) plus `source`, the records
                   file this run read -- so a page rebuilt from the dump alone still names
                   the data rather than the dump
    gt_maps        the record's own maps, when it has any (synthetic records only)
    metrics_gt     the FULL metric dict incl. the GT-comparative entries -- present only
                   when `gt_maps` is, so a Vienna dump cannot carry a meaningless F1
    model          ckpt path, epoch, feature count, head flag, parameter count

Everything under `--dump-maps` is additive: without the flag the output is byte-identical
to what this script always wrote.
"""

import json
import math
import statistics
import sys
from pathlib import Path

import torch

from dataset import piece_to_features_v4, piece_to_features_v41, N_FEATURES_V4, N_FEATURES_V41
from dsl import PAD, V4_MAP_ORDER, decode_piece_v4
from evaluate import (ARTIC_THRESHOLD, constant_baseline, evaluate_piece_v4,  # noqa: PLC2701
                      note_preds_to_articulation, _v4_render)
from model import TempoTransformer

args = sys.argv[1:]


def flag(name, default=None):
    if name in args:
        i = args.index(name)
        v = args[i + 1]
        del args[i : i + 2]
        return v
    return default


def switch(name):
    if name in args:
        args.remove(name)
        return True
    return False


dump_maps = switch("--dump-maps")
ckpt_path = flag("--ckpt")
out_path = flag("--out")
device = torch.device(flag("--device", "cpu"))
limit = int(flag("--limit", str(10 ** 9)))
want_ids = flag("--id")
want_ids = {s.strip() for s in want_ids.split(",")} if want_ids else None
data_path = args[0]

ckpt = torch.load(ckpt_path, map_location="cpu")
cfg = dict(ckpt["config"])
model = TempoTransformer(**cfg).to(device)
model.load_state_dict(ckpt["model"])
model.eval()
n_feat = cfg["n_features"]
assert n_feat in (N_FEATURES_V4, N_FEATURES_V41), f"not a v4-family checkpoint: {n_feat}"
featurize = piece_to_features_v41 if n_feat == N_FEATURES_V41 else piece_to_features_v4
print(f"ckpt: {ckpt_path} epoch {ckpt.get('epoch')} features {n_feat} "
      f"heads {'on' if model.has_heads else 'OFF'}")

# metrics that need no ground-truth MPM (real-data-valid)
GT_FREE = ("render_rmse", "off_rmse", "vel_rmse", "base_render_rmse", "base_off_rmse",
           "base_vel_rmse", "n_nonfinite", "pedal_state_mae")
#: record fields worth carrying into a dump: provenance and the window's coordinates.
META_KEYS = ("id", "piece", "pianist", "source_id", "window_start_beat", "window_beats",
             "window_start_ms", "tail", "ppq", "total_ticks", "seed", "renderer", "era")


def rendered_maps_of(maps, rec, note_pred):
    """The map dict `evaluate_piece_v4` renders for `maps` -- its own first four lines.

    Kept in step with the evaluator by *measurement* rather than by hope: `dump_render`
    re-renders this dict and refuses to write a dump whose RMSEs are not bit-identical to
    the evaluator's, so a divergence here is a crash and never a demo with a plausible
    wrong curve on it.
    """
    pred = {k: list(maps.get(k) or []) for k in V4_MAP_ORDER}
    if note_pred is not None:
        pred["articulation"] = note_preds_to_articulation(rec, note_pred, ARTIC_THRESHOLD)
    if not pred["tempo"] or pred["tempo"][0][0] != 0:
        pred["tempo"] = [[0, 100.0, None, None]] + [t for t in pred["tempo"] if t[0] > 0]
    if not pred["dynamics"] or pred["dynamics"][0][0] != 0:
        pred["dynamics"] = ([[0, 100.0, None, None, None]]
                            + [d for d in pred["dynamics"] if d[0] > 0])
    return pred


def _series(rec, maps):
    """(ms_on, ms_off, velocity) per record note row, `None` where the chain produced none."""
    rendered = _v4_render(rec, maps)
    if rendered is None:
        n = len(rec["notes"])
        return [None] * n, [None] * n, [None] * n
    got, _cc = rendered
    ons = [None if p is None else p.ms_on for p in got]
    offs = [None if p is None else p.ms_off for p in got]
    vels = [None if p is None else p.velocity for p in got]
    return ons, offs, vels


def _ok(triple):
    """The evaluator's inclusion rule: a note counts only if onset, offset AND velocity
    all rendered finite -- it drops the whole row, not the offending field, so an RMSE
    computed field-by-field would be over a different (larger) note set."""
    return [all(v is not None and math.isfinite(v) for v in row) for row in zip(*triple)]


def _rmse(pred, truth, ok):
    se = n = 0
    for p, t, keep in zip(pred, truth, ok):
        if not keep:
            continue
        se += (p - t) ** 2
        n += 1
    return math.sqrt(se / n) if n else float("nan")


def dump_render(rec, maps_rendered, m):
    """Rendered series for the prediction and the constant-tempo baseline.

    Raises if the series do not reproduce `m`'s RMSEs exactly: the dump exists so an
    artifact can plot the same numbers the evaluator scored, and an inexact copy of those
    numbers is worse than none.
    """
    base_tempo = constant_baseline(rec)
    base_maps = {**{k: [] for k in V4_MAP_ORDER}, "tempo": base_tempo}
    on, off, vel = _series(rec, maps_rendered)
    b_on, b_off, b_vel = _series(rec, base_maps)
    notes = rec["notes"]
    gt_on = [n[3] for n in notes]
    gt_off = [n[4] for n in notes]
    gt_vel = [n[5] if len(n) > 5 else 100.0 for n in notes]
    ok, b_ok = _ok((on, off, vel)), _ok((b_on, b_off, b_vel))
    checks = ((on, gt_on, ok, "render_rmse"), (off, gt_off, ok, "off_rmse"),
              (vel, gt_vel, ok, "vel_rmse"),
              (b_on, gt_on, b_ok, "base_render_rmse"), (b_off, gt_off, b_ok, "base_off_rmse"),
              (b_vel, gt_vel, b_ok, "base_vel_rmse"))
    for got, truth, mask, key in checks:
        a, b = _rmse(got, truth, mask), m[key]
        if not (a == b or (a != a and b != b)):
            raise SystemExit(f"--dump-maps: re-render of {key} gives {a!r}, evaluator "
                             f"reported {b!r} -- the dumped maps are not what was scored")
    return {"pred_ms_on": on, "pred_ms_off": off, "pred_velocity": vel,
            "base_ms_on": b_on, "base_ms_off": b_off, "base_velocity": b_vel,
            "base_tempo": base_tempo}

results = []
with torch.no_grad():
    for line in open(data_path):
        if len(results) >= limit:
            break
        rec = json.loads(line)
        if not rec.get("notes"):
            continue
        if want_ids is not None and str(rec.get("id")) not in want_ids:
            continue
        feats = featurize(rec)
        if len(feats) > 320:
            continue
        x = torch.tensor(feats, dtype=torch.float32, device=device).unsqueeze(0)
        xm = torch.zeros(1, x.shape[1], dtype=torch.bool, device=device)

        ids = [t for t in model.greedy_decode(x, xm, max_len=512)[0].cpu().tolist()
               if t != PAD]
        maps, errs = decode_piece_v4(ids, subset="training")

        note_pred = None
        if model.has_heads:
            h = model.note_heads(x, xm)
            note_pred = {
                "artic_present": torch.sigmoid(h["artic_logit"][0]).cpu().tolist(),
                "rel_dur": h["rel_dur"][0].cpu().tolist(),
                "vel_change": h["vel_change"][0].cpu().tolist(),
                "pedal_state": h["pedal_state"][0].cpu().tolist(),
            }

        m = evaluate_piece_v4(maps, rec, note_pred=note_pred)
        row = {"id": rec.get("id"), "piece": rec.get("piece"),
               "n_notes": len(rec["notes"]), "parse_errors": errs,
               "dl_tokens": len(ids), "n_tempo": len(maps.get("tempo") or [])}
        for k in GT_FREE:
            if k in m:
                row[k] = m[k]
        if note_pred:
            row["n_artic_pred"] = sum(1 for p in note_pred["artic_present"] if p > 0.5)
        if dump_maps:
            maps_rendered = rendered_maps_of(maps, rec, note_pred)
            gt_maps = {k: rec[k] for k in V4_MAP_ORDER if rec.get(k)}
            row["model"] = {"ckpt": str(ckpt_path), "epoch": ckpt.get("epoch"),
                            "n_features": n_feat, "heads": bool(model.has_heads),
                            "n_params": sum(p.numel() for p in model.parameters())}
            # The records file goes into the dump so a downstream artifact rebuilt from the
            # dump alone still names the data it came from, instead of naming the dump.
            row["meta"] = {k: rec[k] for k in META_KEYS if k in rec}
            row["meta"]["source"] = data_path
            row["notes"] = rec["notes"]
            row["maps"] = {k: maps.get(k) or [] for k in V4_MAP_ORDER}
            row["maps_rendered"] = maps_rendered
            if note_pred:
                row["note_pred"] = note_pred
            row["render"] = dump_render(rec, maps_rendered, m)
            if gt_maps:
                row["gt_maps"] = gt_maps
                row["metrics_gt"] = m
        results.append(row)

out = out_path or str(Path(data_path).with_suffix(".v4preds.json"))
Path(out).write_text(json.dumps(results, indent=1))


def med(key):
    vals = [r[key] for r in results
            if isinstance(r.get(key), (int, float)) and r[key] == r[key]]
    return statistics.median(vals) if vals else float("nan")


print(f"{len(results)} records -> {out}")
for k in GT_FREE + ("dl_tokens", "n_tempo", "n_artic_pred", "parse_errors"):
    print(f"  {k}: median {med(k):.2f}")
by_piece = {}
for r in results:
    if isinstance(r.get("render_rmse"), float) and r["render_rmse"] == r["render_rmse"]:
        by_piece.setdefault(r.get("piece"), []).append(r["render_rmse"])
for p, v in sorted(by_piece.items(), key=lambda kv: str(kv[0])):
    print(f"  {p}: median render {statistics.median(v):.1f} ms (n={len(v)})")
