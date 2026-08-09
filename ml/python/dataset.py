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

v4 adds two features and re-scopes three of the above to the note's own part; see
:func:`piece_to_features_v4`.
"""

import json
import math
from bisect import bisect_right

import torch
from torch.utils.data import Dataset

from asynchrony_math import AsynchronyTimeline
from dsl import encode_tempo_map, PAD
from perf_chain import _index_at_after

PPQ = 720
N_FEATURES = 9        # v1 (no velocity)
N_FEATURES_V2 = 10    # + velocity/127
N_FEATURES_V31 = 13   # + log2 duration-ratio, onset residual, velocity spike
N_FEATURES_V4 = 15    # + part, pedal state


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


def _v4_part(note):
    """v4 notes are ``[date, dur, pitch, msOn, msOff, vel, part]``; v3's and the pre-part
    Vienna windows' are the same row without the 7th element, which means part 1."""
    return note[6] if len(note) > 6 else 1


def sustain_state_lookup(cc_rows):
    """``sustain_cc`` -> a step function ``ms -> CC value`` (CANONICAL M8 / wave-4 H2).

    The stream is **not** a clean monotone series and must not be scanned sequentially:
    ``getMovementSegment`` emits each segment endpoint twice and a plateau three times
    (36.6 % duplicate timestamps on the pilot), consecutive points can step *backwards* by
    fractions of a millisecond, and a real Vienna window opens with a negative timestamp
    carrying the pedal state the performance was entered with. So: stable sort, then
    last-wins per timestamp (Python's sort keeps the file order of a tie, and the value that
    stands after meico has written them all is the last one). Before the first event the
    state is 0 -- meico's own pedal-up default.
    """
    times, values = [], []
    for point in sorted(cc_rows or [], key=lambda p: p[0]):
        ms, value = float(point[0]), float(point[1])
        if times and times[-1] == ms:
            values[-1] = value
        else:
            times.append(ms)
            values.append(value)

    def state(ms):
        i = bisect_right(times, ms)
        return values[i - 1] if i else 0.0

    return state


def piece_to_features_v4(rec):
    """v3.1's 13 features re-scoped to the note's own part, plus part and pedal state (15).

    Two parts with independent rhythms break three of the v3.1 features if the notes are
    treated as one stream (wave-4 blocker B5). `is_chord_tone` fires on a cross-part
    coincidence that is not a chord; `ioi_beats`/`ioi_s` -- and therefore `local_log2_bpm`,
    the feature the v1/v2 root-cause analysis credits for the model working at all -- are
    measured across the part boundary, where the millisecond IOI carries part 2's asynchrony
    offset (up to +-60 ms) instead of the tempo. The fix is to compute every neighbour- and
    window-based feature inside the part, which is what splitting the record per part and
    running the v3.1 extractor on each does. Only feature 8 has to be repaired afterwards:
    `pos_frac` is a position in the *piece*, so it comes from `total_ticks` (v4 records carry
    it; without it we fall back to the last note end, which is what v3 always used).

      13 part         0 for part 1, 1 for any other part
      14 pedal_state  sustain CC in force at the note's onset, /127

    The pedal lookup happens in the **unshifted** domain: `sustain_cc` is part 1's stream,
    while meico shifts a later part's positionMap by that part's asynchrony offset, so a
    part-2 note sounding at `ms` meets the pedal state the stream has at `ms - offset`.
    """
    notes = sorted(rec["notes"], key=lambda n: (n[0], n[2], _v4_part(n)))
    if not notes:
        return []
    total_ticks = rec.get("total_ticks") or max(n[0] + n[1] for n in notes)
    total_ticks = max(float(total_ticks), 1.0)
    state = sustain_state_lookup(rec.get("sustain_cc"))

    by_part = {}
    for i, note in enumerate(notes):
        by_part.setdefault(_v4_part(note), []).append(i)
    # AS0: the asynchronyMap sits on the LAST part and the flat record spells it globally.
    asyn_part = max(by_part)
    timeline = AsynchronyTimeline(rec.get("asynchrony") or [])

    out = [None] * len(notes)
    for part, idxs in by_part.items():
        rows = piece_to_features_v31({"notes": [notes[i] for i in idxs]})
        for row, i in zip(rows, idxs):
            note = notes[i]
            row[8] = note[0] / total_ticks
            row.append(0.0 if part == 1 else 1.0)
            offset = timeline.offset_at(note[0]) if part == asyn_part else 0.0
            row.append(state(note[3] - offset) / 127.0)
            out[i] = row
    return out


def piece_to_note_labels_v4(rec):
    """Per-note supervision for the two v4 bands the DSL decoder does **not** carry.

    Articulation and pedal were moved out of the token target for two different reasons and
    both end up here, aligned row-for-row with :func:`piece_to_features_v4`:

    *articulation* -- because a date-keyed label is the wrong representation. Even with
    part-local maps (CANONICAL A6) the token cost is a median 186 per piece, and what the
    renderer actually does is modify *notes*; so the label is the resolved effect on each
    note. ``relative_duration`` is a product and ``velocity_change`` a sum, because two
    articulations can land on the same note and meico composes them that way.
    *pedal* -- because a movementMap costs a median 408 tokens, more than every other map
    combined, and the observable is a per-note state anyway.

    Targeting follows meico exactly (:meth:`PerfChain._apply_articulation_at_or_after`): an
    articulation whose date carries no note in its part articulates that part's next note --
    and only the *first* note of it if that is a chord. On A6-conforming data every date is
    an onset of its own part, so this reduces to "all notes at the date"; it is used anyway
    because the rule is what makes a *predicted* map's labels well-defined.

    Returns ``{"artic_present", "relative_duration", "velocity_change", "pedal_state"}``,
    lists of floats; ``pedal_state`` is the integer CC value 0..127, not the /127 feature.
    """
    notes = sorted(rec["notes"], key=lambda n: (n[0], n[2], _v4_part(n)))
    n = len(notes)
    labels = {"artic_present": [0.0] * n, "relative_duration": [1.0] * n,
              "velocity_change": [0.0] * n, "pedal_state": [0.0] * n}
    if not notes:
        return labels

    by_part = {}
    for i, note in enumerate(notes):
        by_part.setdefault(_v4_part(note), []).append(i)

    artic_by_part = {}
    for row in rec.get("articulation") or []:
        artic_by_part.setdefault(row[3] if len(row) > 3 else 1, []).append(row)
    for part, idxs in by_part.items():
        dates = [notes[i][0] for i in idxs]
        for row in artic_by_part.get(part) or []:
            k = _index_at_after(dates, row[0])
            if k < 0:                       # past the part's last note: meico drops it
                continue
            targets = [k]
            j = k + 1
            while j < len(dates) and dates[j] == row[0]:
                targets.append(j)
                j += 1
            for t in targets:
                i = idxs[t]
                labels["artic_present"][i] = 1.0
                labels["relative_duration"][i] *= float(row[1])
                labels["velocity_change"][i] += float(row[2])

    state = sustain_state_lookup(rec.get("sustain_cc"))
    asyn_part = max(by_part)
    timeline = AsynchronyTimeline(rec.get("asynchrony") or [])
    for part, idxs in by_part.items():
        for i in idxs:
            offset = timeline.offset_at(notes[i][0]) if part == asyn_part else 0.0
            labels["pedal_state"][i] = float(state(notes[i][3] - offset))
    return labels


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


def _self_test():
    """Pin the pedal-state conventions. Run: ``python3 dataset.py --self-test``.

    Every case below is a shape the real corpora actually contain, not a hypothetical --
    the pedal lookup is one binary search away from looking correct while reading the wrong
    value, and none of the surrounding gates would notice: a wrong pedal state is a
    plausible number in a plausible range.
    """
    # The Vienna corpus opens a performance with the initial pedal gesture stamped at a
    # single instant: Chopin_op10_no3 carries 315 events all at ms 0, ramping 3 -> 127. The
    # state the excerpt starts in is the LAST of them. A sequential scan, or a sort that is
    # not stable, reads one of the 314 intermediate values instead -- silently, and only on
    # real data, because the synthetic generator never produces a burst this size.
    burst = [[0.0, v] for v in (3, 40, 80, 127)]
    assert sustain_state_lookup(burst)(0.0) == 127.0
    assert sustain_state_lookup(burst)(5.0) == 127.0

    # getMovementSegment emits each segment endpoint twice and a plateau three times
    # (36.6 % duplicate timestamps on the synthetic pilot). Last one wins.
    assert sustain_state_lookup([[0.0, 10], [10.0, 20], [10.0, 30]])(10.0) == 30.0

    # Synthetic streams are not globally monotone (3 pieces on the pilot, max backstep
    # 0.28 ms). Sorting must repair the order rather than the scan trusting it.
    assert sustain_state_lookup([[0.0, 5], [10.28, 60], [10.0, 40]])(10.5) == 60.0

    # A real window can open with the carried-in pedal state at a NEGATIVE timestamp
    # (-1.04 ms in Chopin_op10_no3_p01_w1). A note at ms 0 must see it.
    assert sustain_state_lookup([[-1.04, 64], [500.0, 0]])(0.0) == 64.0

    # The two hazards above CO-OCCUR, which is the configuration real data actually
    # contains: 49 of 88 Vienna performances open their pedal stream before the first
    # matched note, and the opening gesture is a burst at that negative instant --
    # Schubert D783/15 p05 has 127 events at -704.2 ms ramping 8 -> 70, p09 has 101 at
    # -626.0 ms. Pinned together rather than separately, because a lookup can pass both
    # single-hazard cases and still mishandle the pair.
    neg_burst = [[-704.2, v] for v in (8, 30, 55, 70)] + [[1200.0, 0]]
    assert sustain_state_lookup(neg_burst)(-704.2) == 70.0   # last-wins at the burst
    assert sustain_state_lookup(neg_burst)(0.0) == 70.0      # carried into the excerpt
    assert sustain_state_lookup(neg_burst)(-800.0) == 0.0    # ... but not before it

    # Before any event at all the pedal is up -- meico's own default.
    assert sustain_state_lookup([[100.0, 64]])(0.0) == 0.0
    assert sustain_state_lookup([])(0.0) == 0.0

    # A 6-element note row means part 1; a 7-element row carries the part.
    assert _v4_part([0, 720, 60, 0.0, 500.0, 80]) == 1
    assert _v4_part([0, 720, 60, 0.0, 500.0, 80, 2]) == 2
    print("dataset self-test: pedal-state conventions OK")


if __name__ == "__main__":
    import sys as _sys
    if "--self-test" in _sys.argv:
        _self_test()
    else:
        print(__doc__)
