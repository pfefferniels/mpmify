"""Prediction-only inference: run a checkpoint on JSONL records WITHOUT ground-truth
MPM (e.g. real performances like Vienna 4x22) and score in render space only.

Usage: python3 infer.py <ckpt> <data.jsonl> [--v2] [--limit N] [--xml-dir DIR]

Outputs per record: predicted tempo (+dynamics) maps, render-space onset RMSE
(re-rendered predicted map vs the actual performed onsets — needs no GT MPM),
velocity RMSE for v2, constant-tempo baseline, DL (token count). Optionally writes
real MPM XML per piece via dsl_to_mpm (if present). Summary = medians + per-piece file.
"""

import json
import statistics
import sys
from pathlib import Path

import torch

from dataset import piece_to_features, N_FEATURES, N_FEATURES_V2
from dsl import PAD, V1_VOCAB_SIZE, V3_VOCAB_SIZE, VOCAB, decode_tokens, decode_piece
from evaluate import constant_baseline, render_rmse, velocity_render_rmse
from model import TempoTransformer

args = sys.argv[1:]
ckpt_path = args[0]
data_path = args[1]
V2 = "--v2" in args
LIMIT = int(args[args.index("--limit") + 1]) if "--limit" in args else 10 ** 9
XML_DIR = args[args.index("--xml-dir") + 1] if "--xml-dir" in args else None

torch.set_num_threads(4)
ckpt = torch.load(ckpt_path, map_location="cpu")
cfg = dict(ckpt.get("config") or {})
cfg.setdefault("d_model", 160); cfg.setdefault("nhead", 8)
cfg.setdefault("enc_layers", 3); cfg.setdefault("dec_layers", 3); cfg.setdefault("ff", 640)
cfg.setdefault("n_features", N_FEATURES_V2 if V2 else N_FEATURES)
cfg.setdefault("vocab_size", V3_VOCAB_SIZE if V2 else V1_VOCAB_SIZE)
model = TempoTransformer(**cfg)
model.load_state_dict(ckpt["model"])
model.eval()

maps_to_mpm = None
if XML_DIR:
    try:
        from dsl_to_mpm import maps_to_mpm
        Path(XML_DIR).mkdir(parents=True, exist_ok=True)
    except ImportError:
        print("dsl_to_mpm not available; skipping XML export")

records = [json.loads(l) for l in open(data_path)][:LIMIT]
results = []
with torch.no_grad():
    for rec in records:
        feats = piece_to_features(rec, with_velocity=V2)
        if not feats or len(feats) > 320:
            continue
        x = torch.tensor(feats, dtype=torch.float32).unsqueeze(0)
        xm = torch.zeros(1, x.shape[1], dtype=torch.bool)
        ids = [t for t in model.greedy_decode(x, xm, max_len=320 if V2 else 224)[0].tolist()
               if t != PAD]
        if V2:
            tempo, dyn, errs = decode_piece(ids)
        else:
            tempo, errs = decode_tokens(ids)
            dyn = []
        if not tempo or tempo[0][0] != 0:
            tempo = [[0, 100.0, None, None]] + [t for t in tempo if t[0] > 0]
        row = {
            "id": rec.get("id"),
            "piece": rec.get("piece"),
            "n_notes": len(rec["notes"]),
            "n_tempo": len(tempo),
            "n_dyn": len(dyn),
            "parse_errors": errs,
            "dl_tokens": len(ids),
            "render_rmse": render_rmse(tempo, rec),
            "base_render_rmse": render_rmse(constant_baseline(rec), rec),
            "tempo_map": tempo,
        }
        if V2:
            pd = dyn if dyn and dyn[0][0] == 0 else [[0, 100.0, None, None, None]] + \
                [d for d in dyn if d[0] > 0]
            row["vel_rmse"] = velocity_render_rmse(pd, rec)
            vels = [n[5] if len(n) > 5 else 100.0 for n in rec["notes"]]
            mv = sum(vels) / len(vels)
            row["base_vel_rmse"] = (sum((v - mv) ** 2 for v in vels) / len(vels)) ** 0.5
            row["dyn_map"] = pd
        results.append(row)
        if maps_to_mpm and XML_DIR:
            xml = maps_to_mpm(tempo, row.get("dyn_map"))
            (Path(XML_DIR) / f"{rec.get('id', len(results))}.mpm").write_text(xml)

out_path = Path(data_path).with_suffix(".preds.json")
out_path.write_text(json.dumps(results, indent=1))

keys = ["render_rmse", "base_render_rmse", "dl_tokens", "n_tempo", "parse_errors"]
if V2:
    keys += ["vel_rmse", "base_vel_rmse"]
print(f"{len(results)} records -> {out_path}")
for k in keys:
    vals = [r[k] for r in results]
    print(f"  {k}: median {statistics.median(vals):.2f}  p90 "
          f"{sorted(vals)[int(0.9 * (len(vals) - 1))]:.2f}")
by_piece = {}
for r in results:
    by_piece.setdefault(r.get("piece"), []).append(r["render_rmse"])
for p, v in by_piece.items():
    print(f"  {p}: median render_rmse {statistics.median(v):.1f} ms  (n={len(v)})")
