"""Prediction-only v4/v41 inference on records WITHOUT ground-truth MPM (real data).

Usage: python3 infer_v4.py --ckpt <ckpt.pt> <data.jsonl> [--limit N] [--out preds.json]
                           [--device cpu|cuda]

Thin driver over the SAME machinery training uses — no re-implementation:
features via dataset.piece_to_features_v4/_v41 (chosen by the checkpoint's n_features),
decoding via dsl.decode_piece_v4, head readout via model.note_heads, scoring via
evaluate.evaluate_piece_v4 (fixed re-keyed renderer, head-assembled articulation,
baselines, pedal-state MAE against the record's own sustain_cc). On records without
GT maps (Vienna), the GT-comparative outputs (F1s, mdl ratios) are meaningless and
dropped from the report; render/vel/pedal metrics need no GT MPM and are the point.
"""

import json
import statistics
import sys
from pathlib import Path

import torch

from dataset import piece_to_features_v4, piece_to_features_v41, N_FEATURES_V4, N_FEATURES_V41
from dsl import PAD, decode_piece_v4
from evaluate import evaluate_piece_v4
from model import TempoTransformer

args = sys.argv[1:]


def flag(name, default=None):
    if name in args:
        i = args.index(name)
        v = args[i + 1]
        del args[i : i + 2]
        return v
    return default


ckpt_path = flag("--ckpt")
out_path = flag("--out")
device = torch.device(flag("--device", "cpu"))
limit = int(flag("--limit", str(10 ** 9)))
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

results = []
with torch.no_grad():
    for line in open(data_path):
        if len(results) >= limit:
            break
        rec = json.loads(line)
        if not rec.get("notes"):
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
