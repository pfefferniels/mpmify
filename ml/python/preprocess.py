"""JSONL -> packed .pt tensors (memory-frugal: no Python dicts kept at train time).

Usage: python3 preprocess.py ../data/train.jsonl ../data/train.pt [--eval]
--eval additionally stores per-piece note arrays + tempo maps for metric evaluation.
"""

import json
import sys

import torch

from dataset import piece_to_features
from dsl import encode_tempo_map, encode_piece

src, dst = sys.argv[1], sys.argv[2]
keep_eval = "--eval" in sys.argv
v31 = "--v31" in sys.argv  # v3 targets + conditioning features (13)
v3 = "--v3" in sys.argv or v31
v2 = "--v2" in sys.argv or v3

feats, tgts, notes, tempi, dyns, artics, rubs = [], [], [], [], [], [], []
skipped = 0
max_tgt = 448 if v3 else (320 if v2 else 224)
for line in open(src):
    rec = json.loads(line)
    if not rec["notes"]:
        skipped += 1
        continue
    if v3:
        from dsl import encode_piece_v3
        tgt = encode_piece_v3(rec["tempo"], rec.get("dynamics", []),
                              rec.get("articulation", []), rec.get("rubato", []))
    elif v2:
        tgt = encode_piece(rec["tempo"], rec.get("dynamics", []))
    else:
        tgt = encode_tempo_map(rec["tempo"])
    if v31:
        from dataset import piece_to_features_v31
        f = piece_to_features_v31(rec)
    else:
        f = piece_to_features(rec, with_velocity=v2)
    if len(f) > 320 or len(tgt) > max_tgt:
        skipped += 1
        continue
    feats.append(torch.tensor(f, dtype=torch.float32))
    tgts.append(torch.tensor(tgt, dtype=torch.int16))
    if keep_eval:
        ns = sorted(rec["notes"], key=lambda n: (n[0], n[2]))
        notes.append(torch.tensor(ns, dtype=torch.float64))
        tempi.append(rec["tempo"])
        dyns.append(rec.get("dynamics", []))
        artics.append(rec.get("articulation", []))
        rubs.append(rec.get("rubato", []))

obj = {"feats": feats, "tgts": tgts, "v2": v2, "v3": v3}
if keep_eval:
    obj["notes"] = notes
    obj["tempo"] = tempi
    obj["dynamics"] = dyns
    obj["articulation"] = artics
    obj["rubato"] = rubs
torch.save(obj, dst)
print(f"skipped {skipped} (len limits: notes 320, tgt {max_tgt})")
print(f"{dst}: {len(feats)} pieces (skipped {skipped}), "
      f"avg notes {sum(f.shape[0] for f in feats)/len(feats):.0f}, "
      f"avg tgt len {sum(t.shape[0] for t in tgts)/len(tgts):.0f}")
