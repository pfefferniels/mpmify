"""Vienna 4x22 -> our JSONL format, for inference on real human performances.

The corpus (https://github.com/CPJKU/vienna4x22) has 22 professional performances of
4 excerpts, distributed as match files (JKU/Vienna alignment format v1.0.0), which carry
the score note, the performed note and their alignment in one file. We parse with
partitura (the canonical reader) and emit the same record shape the synthetic meico
pipeline produces:

    {"id", "piece", "pianist", "ppq": 720,
     "notes": [[date_ticks, dur_ticks, pitch, msOn, msOff, velocity], ...]}

date_ticks/dur_ticks are score quarters * 720 (beatLength 0.25 convention), shifted so
the first onset is beat 0; msOn/msOff are the performed times in ms, shifted so the first
onset is 0.0. Only matched notes are kept; insertions/deletions are counted per record.

Note offsets are the raw MIDI note-offs by default. The corpus also carries continuous
sustain-pedal data (CC64), and partitura would by default stretch note offsets to the
pedal release ("sound off"). Our training data has no pedal, so pedal-extended offsets
would be out of distribution; --pedal-offsets restores partitura's default behaviour.

Usage:
    python3 vienna_adapter.py                 # full pieces + windows + report
    python3 vienna_adapter.py --no-window
"""

import argparse
import json
import os
import re
import statistics
import sys
import warnings
from collections import Counter

warnings.filterwarnings("ignore")

PPQ = 720
QUARTER_TICKS = PPQ  # beatLength 0.25 -> 0.25 * 4 * 720

HERE = os.path.dirname(os.path.abspath(__file__))
ML_DIR = os.path.dirname(HERE)


def match_files(corpus):
    d = os.path.join(corpus, "match")
    if not os.path.isdir(d):
        sys.exit(f"no match/ directory under {corpus}")
    return sorted(os.path.join(d, f) for f in os.listdir(d) if f.endswith(".match"))


PEDAL_LINE = re.compile(r"^(sustain|soft)\((-?\d+),(\d+)\)")


def parse_pedal(path, sec_per_tick, t0_sec, dedupe):
    """Pedal streams straight from the match text, in file order.

    partitura exposes these as PerformedPart.controls, but it drops exact duplicate
    (time, value) events -- 1,201 of 312,380 sustain events corpus-wide -- and reorders
    events that share a timestamp (2 files differ at t=0). The step function is the same
    either way, but the match text is the authoritative record, and its tick clock is the
    one the note times use (ppq 480 / mpq 500000 uniformly across all 88 files), so this
    stays exactly on the msOn clock.
    """
    streams = {"sustain": [], "soft": []}
    for line in open(path, encoding="utf-8", errors="replace"):
        m = PEDAL_LINE.match(line.strip())
        if not m:
            continue
        ms = round(int(m.group(2)) * sec_per_tick * 1000.0 - t0_sec * 1000.0, 6)
        streams[m.group(1)].append([ms, int(m.group(3))])
    if dedupe:
        for k, evs in streams.items():
            out = []
            for e in evs:
                if not out or out[-1][1] != e[1]:
                    out.append(e)
            streams[k] = out
    return streams["sustain"], streams["soft"]


def state_at(stream, t):
    """Pedal value in force at time t: the last event at or before t, ties last-wins."""
    v = None
    for ms, val in stream:
        if ms > t:
            break
        v = val
    return v


def clip_pedal(stream, lo, hi):
    """Events in [lo, hi] shifted to the window clock, preceded by the carry-in state.

    The last event strictly before the window keeps its (negative) shifted time, so the
    pedal position at window start is always defined; where several events share that
    timestamp only the final one -- the one that actually set the state -- is carried in.
    """
    inside = [[round(ms - lo, 6), v] for ms, v in stream if lo <= ms <= hi]
    before = [e for e in stream if e[0] < lo]
    if before:
        last_t = before[-1][0]
        carry = [e for e in before if e[0] == last_t][-1]
        return [[round(carry[0] - lo, 6), carry[1]]] + inside
    return inside


def parse_match(path, grace_dur_ticks, pedal_offsets, dedupe_pedal=False):
    """-> (record_without_id, meta) using partitura; notes sorted by (date, pitch)."""
    import partitura as pt

    performance, alignment, score = pt.load_match(path, create_score=True)
    for part in performance:
        # 128 is above any CC value, so sound_off == note_off (no pedal extension)
        part.sustain_pedal_threshold = 128 if not pedal_offsets else 64

    sna = score.note_array()
    pna = performance.note_array()
    smap = {str(r["id"]): r for r in sna}
    pmap = {str(r["id"]): r for r in pna}

    labels = Counter(a["label"] for a in alignment)
    pairs = []
    for a in alignment:
        if a["label"] != "match":
            continue
        s = smap.get(str(a["score_id"]))
        p = pmap.get(str(a["performance_id"]))
        if s is None or p is None:
            labels["unresolved"] += 1
            continue
        pairs.append((s, p))
    if not pairs:
        return None, None

    q0 = min(float(s["onset_quarter"]) for s, _ in pairs)
    t0 = min(float(p["onset_sec"]) for _, p in pairs)

    n_grace = 0
    notes = []
    for s, p in pairs:
        date = int(round((float(s["onset_quarter"]) - q0) * QUARTER_TICKS))
        dur = int(round(float(s["duration_quarter"]) * QUARTER_TICKS))
        if dur == 0:
            n_grace += 1
            dur = grace_dur_ticks
        ms_on = (float(p["onset_sec"]) - t0) * 1000.0
        ms_off = ms_on + float(p["duration_sec"]) * 1000.0
        notes.append([date, dur, int(p["pitch"]), ms_on, ms_off, int(p["velocity"])])

    notes.sort(key=lambda n: (n[0], n[2]))

    base = os.path.basename(path)[: -len(".match")]
    piece, pianist = base.rsplit("_p", 1)
    part0 = performance[0]
    sustain, soft = parse_pedal(
        path, part0.mpq / part0.ppq / 1e6, t0, dedupe_pedal
    )
    rec = {
        "id": base,
        "piece": piece,
        "pianist": "p" + pianist,
        "ppq": PPQ,
        "notes": notes,
        "n_insertions": labels.get("insertion", 0),
        "n_deletions": labels.get("deletion", 0),
        "sustain_cc": sustain,
        "soft_cc": soft,
    }
    meta = {
        "n_grace": n_grace,
        # partitura's own count, kept as an independent cross-check on parse_pedal
        "n_sustain_pt": sum(
            1 for part in performance for c in part.controls if c["number"] == 64
        ),
        "n_soft_pt": sum(
            1 for part in performance for c in part.controls if c["number"] == 67
        ),
        "labels": dict(labels),
    }
    return rec, meta


def _emit(rec, sel, start, span, idx, tail):
    d0 = sel[0][0]
    t0 = min(n[3] for n in sel)
    t1 = max(n[4] for n in sel)
    return {
        "id": f"{rec['id']}_w{idx}",
        "piece": rec["piece"],
        "pianist": rec["pianist"],
        "ppq": PPQ,
        "source_id": rec["id"],
        "window_start_beat": round(start, 3),
        "window_beats": span,
        "window_start_ms": round(t0, 6),  # window clock -> full-record clock
        "tail": tail,
        "notes": [[n[0] - d0, n[1], n[2], n[3] - t0, n[4] - t0, n[5]] for n in sel],
        "sustain_cc": clip_pedal(rec["sustain_cc"], t0, t1),
        "soft_cc": clip_pedal(rec["soft_cc"], t0, t1),
    }


def windows(rec, max_beats, min_beats, max_notes, tail_window=True):
    """Non-overlapping windows on whole score beats, plus one back-anchored tail window.

    Nominally max_beats long, but shortened (never below min_beats) so a window stays
    within the model's training length of max_notes -- Chopin op10/3 is dense enough that
    48 beats is the whole piece and ~450 notes. A leftover shorter than min_beats would be
    dropped, so when one exists we emit a final window ending at the last onset instead;
    it overlaps its predecessor and is flagged "tail": true.
    """
    notes = rec["notes"]
    end = max(n[0] for n in notes)
    end_beat = end / QUARTER_TICKS

    def fit(lo_beat, hi_beat_fixed_end):
        """Greedy longest whole-beat span that keeps the note count <= max_notes."""
        span = max_beats
        while span > min_beats:
            if hi_beat_fixed_end:
                lo, hi = (end_beat - span) * QUARTER_TICKS, end + 1
            else:
                lo, hi = lo_beat * QUARTER_TICKS, (lo_beat + span) * QUARTER_TICKS
            if sum(1 for n in notes if lo <= n[0] < hi) <= max_notes:
                break
            span -= 1
        if hi_beat_fixed_end:
            lo, hi = (end_beat - span) * QUARTER_TICKS, end + 1
        else:
            lo, hi = lo_beat * QUARTER_TICKS, (lo_beat + span) * QUARTER_TICKS
        return span, [n for n in notes if lo <= n[0] < hi]

    out = []
    start, idx = 0.0, 0
    while start <= end_beat:
        span, sel = fit(start, False)
        if len(sel) >= 8 and end_beat - start >= min_beats:
            out.append(_emit(rec, sel, start, span, idx, False))
            idx += 1
        start += span

    covered = out[-1]["window_start_beat"] + out[-1]["window_beats"] if out else 0.0
    if tail_window and end_beat - covered > 0.5:
        span, sel = fit(0.0, True)
        if len(sel) >= 8:
            out.append(_emit(rec, sel, round(end_beat - span, 3), span, idx, True))
    return out


def local_bpms(notes):
    """Median-style local tempo from consecutive distinct score onsets."""
    by_onset = {}
    for date, _dur, _p, ms_on, _off, _v in notes:
        by_onset.setdefault(date, []).append(ms_on)
    onsets = sorted(by_onset)
    bpms = []
    for a, b in zip(onsets, onsets[1:]):
        d_beats = (b - a) / QUARTER_TICKS
        d_s = (min(by_onset[b]) - min(by_onset[a])) / 1000.0
        if d_beats > 0 and d_s > 1e-4:
            bpms.append(60.0 * d_beats / d_s)
    return bpms


def check(rec):
    """-> (cross_onset_regressions, chord_internal_regressions, worst_ms, n_bad_velocity)

    Records are sorted by (date, pitch), so within one score onset the performed order is
    whatever the pianist did (melody lead, rolled chords) and back-steps are expected.
    Only a back-step between *distinct* score onsets would mean the alignment or the
    conversion is wrong.
    """
    notes = rec["notes"]
    cross, chord, worst = 0, 0, 0.0
    for i in range(1, len(notes)):
        if notes[i][3] >= notes[i - 1][3]:
            continue
        d = notes[i - 1][3] - notes[i][3]
        if notes[i][0] == notes[i - 1][0]:
            chord += 1
        else:
            cross += 1
            worst = max(worst, d)
    bad_vel = sum(1 for n in notes if not (1 <= n[5] <= 127))
    return cross, chord, worst, bad_vel


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default=os.path.join(ML_DIR, "data", "vienna4x22"))
    ap.add_argument("--out", default=os.path.join(ML_DIR, "data", "vienna_infer.jsonl"))
    ap.add_argument(
        "--out-windows",
        default=os.path.join(ML_DIR, "data", "vienna_infer_windows.jsonl"),
    )
    ap.add_argument("--no-window", action="store_true")
    ap.add_argument(
        "--no-tail-window",
        action="store_true",
        help="drop the back-anchored final window (leaves the piece tail uncovered)",
    )
    ap.add_argument("--window-beats", type=int, default=48)
    ap.add_argument("--min-window-beats", type=int, default=16)
    ap.add_argument("--max-notes", type=int, default=320)
    ap.add_argument(
        "--grace-dur-ticks",
        type=int,
        default=180,
        help="score duration given to grace notes (0 in the match file); 0 keeps them at 0",
    )
    ap.add_argument(
        "--pedal-offsets",
        action="store_true",
        help="extend note offsets to sustain-pedal release (partitura default)",
    )
    ap.add_argument(
        "--dedupe-pedal",
        action="store_true",
        help="collapse consecutive pedal events that repeat the previous value",
    )
    args = ap.parse_args()

    files = match_files(args.corpus)
    print(f"{len(files)} match files under {args.corpus}")

    recs, wins, metas = [], [], []
    for path in files:
        rec, meta = parse_match(
            path, args.grace_dur_ticks, args.pedal_offsets, args.dedupe_pedal
        )
        if rec is None:
            print(f"  SKIP (no matched notes): {path}")
            continue
        recs.append(rec)
        metas.append(meta)
        if not args.no_window:
            wins.extend(
                windows(
                    rec,
                    args.window_beats,
                    args.min_window_beats,
                    args.max_notes,
                    not args.no_tail_window,
                )
            )

    for path, rs in ((args.out, recs), (args.out_windows, wins)):
        if rs is None or (path == args.out_windows and args.no_window):
            continue
        with open(path, "w") as f:
            for r in rs:
                f.write(json.dumps(r) + "\n")
        print(f"wrote {len(rs)} records -> {path}")

    # ---- validation / sanity report -------------------------------------------------
    bad = 0
    for r in recs + wins:
        _cross, _chord, _worst, bad_vel = check(r)
        if bad_vel:
            print(f"  !! {r['id']}: {bad_vel} velocities outside [1,127]")
            bad += bad_vel

    by_piece = {}
    for r, m in zip(recs, metas):
        by_piece.setdefault(r["piece"], []).append((r, m))

    print("\n=== full pieces ===")
    hdr = (
        f"{'piece':<22}{'perf':>5}{'notes':>7}{'beats':>7}{'sec':>7}"
        f"{'BPM p10/med/p90 (quarter)':>28}{'vel':>10}{'ins':>5}{'del':>5}"
    )
    print(hdr)
    for piece, items in sorted(by_piece.items()):
        notes_n = [len(r["notes"]) for r, _ in items]
        beats = [max(n[0] for n in r["notes"]) / QUARTER_TICKS for r, _ in items]
        secs = [max(n[4] for n in r["notes"]) / 1000.0 for r, _ in items]
        allb = [b for r, _ in items for b in local_bpms(r["notes"])]
        vmin = min(n[5] for r, _ in items for n in r["notes"])
        vmax = max(n[5] for r, _ in items for n in r["notes"])
        ins = sum(r["n_insertions"] for r, _ in items)
        dele = sum(r["n_deletions"] for r, _ in items)
        print(
            f"{piece:<22}{len(items):>5}{statistics.median(notes_n):>7.0f}"
            f"{statistics.median(beats):>7.1f}{statistics.median(secs):>7.1f}"
            f"{pct(allb,0.10):>12.1f}{statistics.median(allb):>8.1f}{pct(allb,0.90):>8.1f}"
            f"{vmin:>6}-{vmax:<3}{ins:>5}{dele:>5}"
        )

    print("\n=== per-piece mean tempo across the 22 pianists (quarter BPM) ===")
    for piece, items in sorted(by_piece.items()):
        means = []
        for r, _ in items:
            beats = max(n[0] for n in r["notes"]) / QUARTER_TICKS
            secs = max(n[3] for n in r["notes"]) / 1000.0
            means.append(60.0 * beats / secs if secs > 0 else 0.0)
        print(
            f"{piece:<22} min {min(means):5.1f}  median {statistics.median(means):5.1f}"
            f"  max {max(means):5.1f}"
        )

    if wins:
        print("\n=== windows ===")
        wb = {}
        for w in wins:
            wb.setdefault(w["piece"], []).append(w)
        print(
            f"{'piece':<22}{'wins':>6}{'per perf':>9}{'notes med/max':>16}"
            f"{'beats':>8}{'tail':>6}{'note coverage':>15}"
        )
        for piece, ws in sorted(wb.items()):
            nn = [len(w["notes"]) for w in ws]
            spans = sorted({w["window_beats"] for w in ws})
            n_tail = sum(1 for w in ws if w["tail"])
            src = {w["source_id"] for w in ws}
            # windows keep relative dates off a whole-beat start, so absolute dates
            # reconstruct exactly and coverage is an exact set membership test
            seen = {
                (w["source_id"], int(w["window_start_beat"] * QUARTER_TICKS) + n[0], n[2])
                for w in ws
                for n in w["notes"]
            }
            total = sum(len(r["notes"]) for r, _ in by_piece[piece])
            covered = sum(
                1
                for r, _ in by_piece[piece]
                for n in r["notes"]
                if (r["id"], n[0], n[2]) in seen
            )
            print(
                f"{piece:<22}{len(ws):>6}{len(ws)/len(src):>9.1f}"
                f"{statistics.median(nn):>9.0f}/{max(nn):<6}{str(spans):>8}"
                f"{n_tail:>6}{100.0*covered/total:>14.1f}%"
            )
        over = [w["id"] for w in wins if len(w["notes"]) > args.max_notes]
        if over:
            print(f"  {len(over)} windows still exceed {args.max_notes} notes: {over[:5]}")

    print("\n=== validation ===")
    print(f"velocities outside [1,127]: {bad}")
    for label, rs in (("full", recs), ("windows", wins)):
        if not rs:
            continue
        checks = [check(r) for r in rs]
        cross = sum(c[0] for c in checks)
        chord = sum(c[1] for c in checks)
        worst = max(c[2] for c in checks)
        tot_notes = sum(len(r["notes"]) for r in rs)
        n_with = sum(1 for c in checks if c[0])
        print(
            f"{label}: {len(rs)} records, {tot_notes} notes; "
            f"msOn back-steps between distinct score onsets: {cross} "
            f"in {n_with}/{len(rs)} records (worst {worst:.1f} ms); "
            f"within-onset (chord spread / melody lead): {chord} pairs "
            f"({100.0*chord/max(1,tot_notes):.1f}% of notes)"
        )
    spreads = []
    for r in recs:
        cur = []
        for i, n in enumerate(r["notes"]):
            if i and n[0] != r["notes"][i - 1][0]:
                if len(cur) > 1:
                    spreads.append(max(cur) - min(cur))
                cur = []
            cur.append(n[3])
        if len(cur) > 1:
            spreads.append(max(cur) - min(cur))
    if spreads:
        spreads.sort()
        print(
            f"chord onset spread (ms): median {statistics.median(spreads):.1f} "
            f"p90 {pct(spreads,0.90):.1f} p99 {pct(spreads,0.99):.1f} max {spreads[-1]:.1f} "
            f"over {len(spreads)} multi-note onsets"
        )
    print(
        f"grace notes (score duration 0 -> {args.grace_dur_ticks} ticks): "
        f"{sum(m['n_grace'] for m in metas)}"
    )
    print(f"alignment labels: {dict(sum((Counter(m['labels']) for m in metas), Counter()))}")

    # ---- pedal -----------------------------------------------------------------------
    print("\n=== pedal ===")
    n_sus = sum(len(r["sustain_cc"]) for r in recs)
    n_soft = sum(len(r["soft_cc"]) for r in recs)
    print(
        f"full records: {n_sus} sustain + {n_soft} soft events "
        f"(partitura's own count: {sum(m['n_sustain_pt'] for m in metas)} / "
        f"{sum(m['n_soft_pt'] for m in metas)}"
        f"{' -- partitura drops exact duplicate (time,value) events' if not args.dedupe_pedal else ''})"
    )
    bad_ms, bad_val, empty = 0, 0, 0
    for r in recs + wins:
        for key in ("sustain_cc", "soft_cc"):
            s = r[key]
            if not s:
                empty += 1
                continue
            bad_ms += sum(1 for a, b in zip(s, s[1:]) if b[0] < a[0])
            bad_val += sum(1 for _, v in s if not (0 <= v <= 127))
    print(f"non-monotonic ms: {bad_ms}; values outside [0,127]: {bad_val}; empty streams: {empty}")
    neg = sum(1 for r in recs for k in ("sustain_cc", "soft_cc") for ms, _ in r[k] if ms < 0)
    print(f"events before the first matched note (negative ms, kept): {neg}")

    if wins:
        w_sus = sum(len(w["sustain_cc"]) for w in wins)
        carry = sum(
            1 for w in wins for k in ("sustain_cc", "soft_cc") if w[k] and w[k][0][0] < 0
        )
        nostate = sum(
            1
            for w in wins
            for k in ("sustain_cc", "soft_cc")
            if not w[k] or w[k][0][0] > 0
        )
        print(
            f"windows: {w_sus} sustain events; {carry} streams carry an initial ms<0 "
            f"state event; {nostate} have no state defined at ms<=0"
        )
        # Structural check: the in-window events must be exactly the source events over
        # the window span, shifted; and the carry-in must be the state entering the
        # window. (A pointwise state probe is meaningless here -- the corpus stamps
        # hundreds of events on a single timestamp, so only the last one sets the state.)
        full_by_id = {r["id"]: r for r in recs}
        ev_bad = carry_bad = carry_n = 0
        for w in wins:
            src = full_by_id[w["source_id"]]
            off = w["window_start_ms"]
            lo, hi = off, off + max(n[4] for n in w["notes"])
            for key in ("sustain_cc", "soft_cc"):
                got = [e for e in w[key] if e[0] >= 0]
                want = [e for e in src[key] if lo <= e[0] <= hi]
                if len(got) != len(want) or any(
                    abs((g[0] + off) - t[0]) > 1e-6 or g[1] != t[1]
                    for g, t in zip(got, want)
                ):
                    ev_bad += 1
                head = [e for e in w[key] if e[0] < 0]
                if head:
                    carry_n += 1
                    before = [e for e in src[key] if e[0] < lo]
                    if not before or head[-1][1] != before[-1][1]:
                        carry_bad += 1
        print(
            f"window pedal vs full record: {ev_bad} streams with wrong events, "
            f"{carry_bad} wrong carry-in values (of {carry_n} carry-ins), over "
            f"{2*len(wins)} streams"
        )
        burst = max(
            sum(1 for ms, _ in r["sustain_cc"] if ms == r["sustain_cc"][0][0])
            for r in recs
        )
        print(
            f"largest burst of sustain events sharing one timestamp: {burst} "
            f"(corpus stamps the initial pedal ramp at tick 0)"
        )


if __name__ == "__main__":
    main()
