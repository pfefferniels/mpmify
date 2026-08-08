"""Failure analysis: print GT vs predicted tempo maps for val pieces.

Usage: python3 inspect_preds.py [ckpt] [n_pieces] [data]
"""

import sys

import torch

from dataset import TempoDataset
from dsl import decode_tokens
from evaluate import evaluate_piece
from model import TempoTransformer
from tempo_math import TempoTimeline, PPQ

ckpt_path = sys.argv[1] if len(sys.argv) > 1 else "../runs/v0/ckpt.pt"
n_pieces = int(sys.argv[2]) if len(sys.argv) > 2 else 8
data = sys.argv[3] if len(sys.argv) > 3 else "../data/val.jsonl"

device = torch.device("cpu")
ckpt = torch.load(ckpt_path, map_location=device)
cfg = dict(ckpt.get("config") or {})
cfg.setdefault("d_model", 160); cfg.setdefault("nhead", 8)
cfg.setdefault("enc_layers", 3); cfg.setdefault("dec_layers", 3); cfg.setdefault("ff", 640)
cfg.setdefault("n_features", 9); cfg.setdefault("vocab_size", 19)  # v1 defaults
model = TempoTransformer(**cfg).to(device)
model.load_state_dict(ckpt["model"])
model.eval()
print(f"ckpt epoch {ckpt.get('epoch')} val {ckpt.get('val')}\n")

ds = TempoDataset(data)


def fmt_map(m):
    out = []
    for d, bpm, to, mta in m:
        if to is None:
            out.append(f"{d/PPQ:6.1f}b  {bpm:6.1f} const")
        else:
            out.append(f"{d/PPQ:6.1f}b  {bpm:6.1f} -> {to:6.1f} @ {mta}")
    return out


def sparkline(tl, total_ticks, width=64):
    chars = "▁▂▃▄▅▆▇█"
    import math
    vals = [math.log2(tl.bpm_at(total_ticks * i / (width - 1))) for i in range(width)]
    lo, hi = math.log2(35), math.log2(210)
    return "".join(chars[min(7, max(0, int((v - lo) / (hi - lo) * 8)))] for v in vals)


for i in range(n_pieces):
    x, y, idx = ds[i]
    rec = ds.records[idx]
    xb = x.unsqueeze(0).to(device)
    xm = torch.zeros(1, x.shape[0], dtype=torch.bool, device=device)
    ids = model.greedy_decode(xb, xm, max_len=256)[0].tolist()
    pred, errs = decode_tokens(ids)
    if not pred:
        pred = [[0, 100.0, None, None]]
    met = evaluate_piece(pred, rec)
    total = max(n[0] + n[1] for n in rec["notes"])
    print(f"=== piece {rec['id']}  notes={len(rec['notes'])}  parse_errors={errs}")
    print(f"    curve_rmse={met['curve_rmse']:.4f} render_rmse={met['render_rmse']:.1f}ms "
          f"(base {met['base_render_rmse']:.1f}ms) boundary_f1={met['boundary_f1']:.2f}")
    print("    GT   " + sparkline(TempoTimeline(rec["tempo"]), total))
    print("    PRED " + sparkline(TempoTimeline(pred), total))
    gt_lines, pr_lines = fmt_map(rec["tempo"]), fmt_map(pred)
    for j in range(max(len(gt_lines), len(pr_lines))):
        g = gt_lines[j] if j < len(gt_lines) else ""
        p = pr_lines[j] if j < len(pr_lines) else ""
        print(f"    GT: {g:<38} PRED: {p}")
    print()
