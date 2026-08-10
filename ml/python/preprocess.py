"""JSONL -> packed .pt tensors (memory-frugal: no Python dicts kept at train time).

Usage: python3 preprocess.py ../data/train.jsonl ../data/train.pt [--v2|--v3|--v31|--v4] [--eval]
--eval additionally stores per-piece note arrays + maps for metric evaluation.
"""

import json
import sys

import torch

from dataset import piece_to_features
from dsl import encode_piece, encode_tempo_map

src, dst = sys.argv[1], sys.argv[2]
keep_eval = "--eval" in sys.argv
v41 = "--v41" in sys.argv  # v4 targets/labels + 16 features (cross-part offset)
v4 = "--v4" in sys.argv or v41  # v4 targets (tempo+dynamics+rubato+asynchrony) + 15 features
v31 = "--v31" in sys.argv  # v3 targets + conditioning features (13)
v3 = "--v3" in sys.argv or v31
v2 = "--v2" in sys.argv or v3

#: Target-length caps. v1/v2/v3 are the shipped values and are frozen with their datasets.
#:
#: v4's is set from the measurement rather than from the architecture note. Over **200**
#: pieces (two independent 100-piece A6 pilots, seeds 3001 and 4001) the training subset
#: -- tempo+dynamics+rubato+asynchrony; articulation and pedal are per-note labels, not
#: tokens -- is median 181, p90 265, p95 296, p99 339, **max 435**.
#:
#: The 320 the wave plan carried predates the measurement and rejects 2.5 % of pieces; 384
#: still rejects 1.0 %, because a single 100-piece sample does not see the tail. 448 covers
#: 200/200 and is v3's value, so it is one number rather than two. It is not a *proof*: the
#: sampler's own worst case (64 beats, 4-beat minimum segments, every instruction a
#: transition) is ~770 tokens, so a legitimate piece can still overflow -- which is why the
#: overflow is a hard failure below rather than a filter.
#:
#: Cost of the headroom: none worth counting. Training batches pad to their own longest
#: target, not to the cap, and `TempoTransformer.greedy_decode` breaks as soon as every
#: sequence in the batch has emitted EOS, so the ceiling is a safety limit and not a
#: per-step price.
#: v4 raised 448 -> 512 on 2026-08-09: the first full 20k generation produced 6/20000
#: pieces (0.03 %) above 448 (max 472) — the deliberate-raise path this guard exists for.
MAX_TGT = {"v1": 224, "v2": 320, "v3": 448, "v4": 512}
MAX_TGT["v41"] = MAX_TGT["v4"]
MAX_NOTES = 320
VERSION = "v41" if v41 else ("v4" if v4 else ("v3" if v3 else ("v2" if v2 else "v1")))
max_tgt = MAX_TGT[VERSION]

feats, tgts, notes, tempi, dyns, artics, rubs = [], [], [], [], [], [], []
movs, asyns, ticks, sustains, labels = [], [], [], [], []
skipped = 0
overlong = []
for line_no, line in enumerate(open(src)):
    rec = json.loads(line)
    if not rec["notes"]:
        skipped += 1
        continue
    if v4:
        from dsl import encode_piece_v4
        from dataset import piece_to_features_v4, piece_to_note_labels_v4
        tgt = encode_piece_v4({k: rec.get(k) or [] for k in
                               ("tempo", "dynamics", "rubato", "articulation",
                                "movement", "asynchrony")}, subset="training")
        if v41:
            from dataset import piece_to_features_v41
            f = piece_to_features_v41(rec)
        else:
            f = piece_to_features_v4(rec)
    elif v3:
        from dsl import encode_piece_v3
        tgt = encode_piece_v3(rec["tempo"], rec.get("dynamics", []),
                              rec.get("articulation", []), rec.get("rubato", []))
        from dataset import piece_to_features_v31
        f = piece_to_features_v31(rec) if v31 else piece_to_features(rec, with_velocity=True)
    else:
        tgt = encode_piece(rec["tempo"], rec.get("dynamics", [])) if v2 \
            else encode_tempo_map(rec["tempo"])
        f = piece_to_features(rec, with_velocity=v2)
    if len(f) > MAX_NOTES or len(tgt) > max_tgt:
        # v4 fails loudly. Silently dropping the pieces that do not fit is how a whole
        # generation can be reduced to a fraction of itself behind a one-line count -- and
        # the ones that overflow are exactly the long, densely-marked pieces the model most
        # needs to see, so the survivors are a biased sample as well as a small one.
        if v4:
            overlong.append((rec.get("id", line_no), len(f), len(tgt)))
            continue
        skipped += 1
        continue
    feats.append(torch.tensor(f, dtype=torch.float32))
    tgts.append(torch.tensor(tgt, dtype=torch.int16))
    if v4:
        lab = piece_to_note_labels_v4(rec)
        labels.append(torch.tensor(
            [lab["artic_present"], lab["relative_duration"], lab["velocity_change"],
             lab["pedal_state"]], dtype=torch.float32).T.contiguous())
    if keep_eval:
        ns = sorted(rec["notes"], key=lambda n: (n[0], n[2], n[6] if len(n) > 6 else 1))
        notes.append(torch.tensor(ns, dtype=torch.float64))
        tempi.append(rec["tempo"])
        dyns.append(rec.get("dynamics", []))
        artics.append(rec.get("articulation", []))
        rubs.append(rec.get("rubato", []))
        if v4:
            # the v4 evaluator renders through PerfChainV4, which needs the whole map set,
            # the piece length pos_frac was taken from, and the pedal ground truth
            movs.append(rec.get("movement", []))
            asyns.append(rec.get("asynchrony", []))
            ticks.append(rec.get("total_ticks"))
            sustains.append(rec.get("sustain_cc", []))

if overlong:
    worst = sorted(overlong, key=lambda r: -r[2])[:5]
    raise SystemExit(
        f"{len(overlong)} of {len(feats) + len(overlong) + skipped} pieces exceed the "
        f"{VERSION} limits (notes {MAX_NOTES}, target {max_tgt}); longest: "
        + ", ".join(f"id {i} ({n} notes, {t} tokens)" for i, n, t in worst)
        + f"\nRaise MAX_TGT['{VERSION}'] in preprocess.py (and MAX_DECODE in train.py with "
          f"it) or re-tune the sampler -- do not drop them silently.")

# The packed set records the ceiling it was built at, so `train.py` decodes to the length
# the data was actually allowed to reach instead of to a constant that has to be kept in
# sync by hand -- decoding shorter than the pack silently truncates the longest targets.
obj = {"feats": feats, "tgts": tgts, "v2": v2, "v3": v3, "v4": v4, "max_tgt": max_tgt}
if v4:
    obj["note_labels"] = labels
if keep_eval:
    obj["notes"] = notes
    obj["tempo"] = tempi
    obj["dynamics"] = dyns
    obj["articulation"] = artics
    obj["rubato"] = rubs
    if v4:
        obj["movement"] = movs
        obj["asynchrony"] = asyns
        obj["total_ticks"] = ticks
        obj["sustain_cc"] = sustains
torch.save(obj, dst)
print(f"skipped {skipped} (empty)   limits: notes {MAX_NOTES}, tgt {max_tgt}")
print(f"{dst}: {len(feats)} pieces, "
      f"avg notes {sum(f.shape[0] for f in feats)/len(feats):.0f}, "
      f"avg tgt len {sum(t.shape[0] for t in tgts)/len(tgts):.0f}, "
      f"max tgt len {max(t.shape[0] for t in tgts)}")
