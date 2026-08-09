"""JSONL -> tensors. Input: per-note continuous features exploiting the alignment.

Per-note features (F=9):
  0 onset_beats / 100
  1 duration_beats
  2 perf_onset_s / 60
  3 perf_duration_s
  4 ioi_beats        (score IOI to next distinct onset; 0 for chord tones)
  5 ioi_s            (performance IOI to next distinct onset)
  6 local_log2_bpm   (log2 of 60*ioi_beats/ioi_s, 0 where undefined) / 4
  7 is_chord_tone    (1 if same onset as previous note)
  8 pos_frac         (onset / piece length)
"""

import json
import math

import torch
from torch.utils.data import Dataset

from dsl import encode_tempo_map, PAD

PPQ = 720
N_FEATURES = 9        # v1 (no velocity)
N_FEATURES_V2 = 10    # + velocity/127
N_FEATURES_V31 = 13   # + log2 duration-ratio, onset residual, velocity spike


def piece_to_features(rec, with_velocity=False):
    notes = sorted(rec["notes"], key=lambda n: (n[0], n[2]))
    total_ticks = max(n[0] + n[1] for n in notes)
    # distinct onsets for IOI computation
    feats = []
    n = len(notes)
    for i, note in enumerate(notes):
        date, dur, pitch, ms_on, ms_off = note[:5]
        # next distinct onset
        j = i + 1
        while j < n and notes[j][0] == date:
            j += 1
        if j < n:
            ioi_beats = (notes[j][0] - date) / PPQ
            ioi_s = (notes[j][3] - ms_on) / 1000.0
        else:
            ioi_beats = ioi_s = 0.0
        if ioi_beats > 0 and ioi_s > 1e-6:
            llb = math.log2(60.0 * ioi_beats / ioi_s)
        else:
            llb = 0.0
        is_chord = 1.0 if i > 0 and notes[i - 1][0] == date else 0.0
        row = [
            date / PPQ / 100.0,
            dur / PPQ,
            ms_on / 1000.0 / 60.0,
            (ms_off - ms_on) / 1000.0,
            ioi_beats,
            ioi_s,
            llb / 4.0,
            is_chord,
            date / total_ticks,
        ]
        if with_velocity:
            row.append((note[5] if len(note) > 5 else 100.0) / 127.0)
        feats.append(row)
    return feats


def piece_to_features_v31(rec):
    """v3.1: v2 features + three conditioning features that expose the articulation
    and rubato signals directly (the encoder should not have to derive them):
      10 log2 duration-ratio  — perf duration vs score duration at LOCAL tempo
                                (articulation relativeDuration signature)
      11 onset residual       — perf onset minus local linear (beats->sec) fit,
                                in beats (rubato intra-frame warp signature)
      12 velocity spike       — velocity minus local median velocity
                                (articulation velocityChange signature vs the
                                smooth dynamics curve)
    Local window: notes within +-2 beats (min 3 distinct onsets, else widen to +-4,
    else piece-global)."""
    import math as _m

    base = piece_to_features(rec, with_velocity=True)
    notes = sorted(rec["notes"], key=lambda n: (n[0], n[2]))
    n = len(notes)
    beats = [nt[0] / PPQ for nt in notes]
    secs = [nt[3] / 1000.0 for nt in notes]
    vels = [(nt[5] if len(nt) > 5 else 100.0) for nt in notes]

    def local_fit(i, half_beats):
        """least-squares sec = a*beat + b over the window; returns (a, b) or None"""
        b0 = beats[i]
        xs, ys = [], []
        seen = set()
        for j in range(n):
            if abs(beats[j] - b0) <= half_beats and beats[j] not in seen:
                seen.add(beats[j])
                xs.append(beats[j])
                ys.append(secs[j])
        if len(xs) < 3:
            return None
        mx = sum(xs) / len(xs)
        my = sum(ys) / len(ys)
        den = sum((x - mx) ** 2 for x in xs)
        if den < 1e-12:
            return None
        a = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den
        return a, my - a * mx

    # piece-global fallback fit
    gfit = local_fit(0, float("inf"))
    for i in range(n):
        fit = local_fit(i, 2.0) or local_fit(i, 4.0) or gfit
        a, b = fit if fit else (0.5, 0.0)
        spb = max(a, 1e-3)  # seconds per beat locally
        # 10: log2 duration ratio
        score_dur_s = (notes[i][1] / PPQ) * spb
        perf_dur_s = max((notes[i][4] - notes[i][3]) / 1000.0, 1e-3)
        r = _m.log2(max(perf_dur_s, 1e-3) / max(score_dur_s, 1e-3))
        base[i].append(max(-2.0, min(2.0, r)) / 2.0)
        # 11: onset residual in beats
        resid = (secs[i] - (a * beats[i] + b)) / spb
        base[i].append(max(-1.0, min(1.0, resid)))
        # 12: velocity spike vs local median
        wv = [vels[j] for j in range(n) if abs(beats[j] - beats[i]) <= 2.0]
        med = sorted(wv)[len(wv) // 2] if wv else 100.0
        base[i].append(max(-1.0, min(1.0, (vels[i] - med) / 32.0)))
    return base


class TempoDataset(Dataset):
    def __init__(self, path, max_notes=384, max_out=256):
        self.records = []
        skipped = 0
        for line in open(path):
            rec = json.loads(line)
            if not rec["notes"]:
                skipped += 1
                continue
            tgt = encode_tempo_map(rec["tempo"])
            if len(rec["notes"]) > max_notes or len(tgt) > max_out:
                skipped += 1
                continue
            self.records.append(rec)
        if skipped:
            print(f"{path}: kept {len(self.records)}, skipped {skipped}")

    def __len__(self):
        return len(self.records)

    def __getitem__(self, idx):
        rec = self.records[idx]
        x = torch.tensor(piece_to_features(rec), dtype=torch.float32)
        y = torch.tensor(encode_tempo_map(rec["tempo"]), dtype=torch.long)
        return x, y, idx


def collate(batch):
    xs, ys, idxs = zip(*batch)
    max_n = max(x.shape[0] for x in xs)
    max_t = max(y.shape[0] for y in ys)
    B = len(xs)
    x_pad = torch.zeros(B, max_n, N_FEATURES)
    x_mask = torch.ones(B, max_n, dtype=torch.bool)  # True = padding
    y_pad = torch.full((B, max_t), PAD, dtype=torch.long)
    for i, (x, y) in enumerate(zip(xs, ys)):
        x_pad[i, : x.shape[0]] = x
        x_mask[i, : x.shape[0]] = False
        y_pad[i, : y.shape[0]] = y
    return x_pad, x_mask, y_pad, list(idxs)
