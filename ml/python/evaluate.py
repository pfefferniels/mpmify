"""Evaluation: curve-space + render-space metrics, vs a constant-tempo baseline.

- curve RMSE: log2 BPM sampled every 90 ticks, predicted vs ground-truth map
- render RMSE: per-note onset error (ms) when re-rendering the predicted map
  with the exact meico math, after aligning at t=0 (both start at 0 anyway)
- baseline: single constant tempo that maps total beats to total performed seconds
"""

import math

from tempo_math import TempoTimeline, PPQ


def constant_baseline(rec):
    notes = rec["notes"]
    first = min(n[0] for n in notes)
    last = max(n[0] for n in notes)
    ms_first = min(n[3] for n in notes)
    ms_last = max(n[3] for n in notes)
    if last == first or ms_last <= ms_first:
        return [[0, 100.0, None, None]]
    beats = (last - first) / PPQ
    bpm = 60000.0 * beats / (ms_last - ms_first)
    return [[0, bpm, None, None]]


def curve_rmse(map_a, map_b, total_ticks, step=90):
    tla, tlb = TempoTimeline(map_a), TempoTimeline(map_b)
    se = n = 0
    t = 0
    while t <= total_ticks:
        se += (math.log2(tla.bpm_at(t)) - math.log2(tlb.bpm_at(t))) ** 2
        n += 1
        t += step
    return math.sqrt(se / n)


def render_rmse(pred_map, rec):
    """Onset RMSE in ms of re-rendered predicted map vs actual performed onsets."""
    tl = TempoTimeline(pred_map)
    se = n = 0
    for date, dur, pitch, ms_on, ms_off, *_ in rec["notes"]:
        e = tl.ms_at(date) - ms_on
        se += e * e
        n += 1
    return math.sqrt(se / n)


def boundary_prf(pred_map, gt_map, tol_ticks=PPQ):
    """Precision/recall/F1 of instruction boundaries within +-tol."""
    pd = [p[0] for p in pred_map]
    gd = [g[0] for g in gt_map]
    used = set()
    tp = 0
    for p in pd:
        best = None
        for i, g in enumerate(gd):
            if i in used or abs(g - p) > tol_ticks:
                continue
            if best is None or abs(g - p) < abs(gd[best] - p):
                best = i
        if best is not None:
            used.add(best)
            tp += 1
    prec = tp / len(pd) if pd else 0.0
    rec = tp / len(gd) if gd else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return prec, rec, f1


def evaluate_piece(pred_map, rec):
    if not pred_map or pred_map[0][0] != 0:
        # ensure an instruction at 0 (meico default would be 100 bpm)
        pred_map = [[0, 100.0, None, None]] + [p for p in pred_map if p[0] > 0]
    gt_map = rec["tempo"]
    total_ticks = max(n[0] + n[1] for n in rec["notes"])
    base = constant_baseline(rec)
    return {
        "curve_rmse": curve_rmse(pred_map, gt_map, total_ticks),
        "render_rmse": render_rmse(pred_map, rec),
        "base_curve_rmse": curve_rmse(base, gt_map, total_ticks),
        "base_render_rmse": render_rmse(base, rec),
        "boundary_f1": boundary_prf(pred_map, gt_map)[2],
        "n_pred": len(pred_map),
        "n_gt": len(gt_map),
    }


# ---------- v3: full-chain evaluation via PerfChain ----------

def evaluate_piece_v3(pred_tempo, pred_dyn, pred_artic, pred_rubato, rec):
    """Render-space evaluation of a full v3 prediction with the exact meico chain.
    NaN/None-guarded: non-finite renders count into `n_nonfinite` and are excluded
    from the RMSE instead of poisoning it."""
    from perf_chain import PerfChain

    if not pred_tempo or pred_tempo[0][0] != 0:
        pred_tempo = [[0, 100.0, None, None]] + [t for t in pred_tempo if t[0] > 0]
    if not pred_dyn or pred_dyn[0][0] != 0:
        pred_dyn = [[0, 100.0, None, None, None]] + [d for d in pred_dyn if d[0] > 0]

    notes = rec["notes"]
    score = [(n[0], n[1]) for n in notes]
    out = {}
    for name, chain in (
        ("", PerfChain(pred_tempo, pred_dyn, pred_artic, pred_rubato)),
        ("base_", PerfChain(constant_baseline(rec), None, None, None)),
    ):
        try:
            rendered = chain.render(score)
        except (ValueError, TypeError):
            out[name + "render_rmse"] = float("nan")
            out[name + "vel_rmse"] = float("nan")
            out[name + "n_nonfinite"] = len(notes)
            continue
        se_ms = se_v = n = bad = 0
        for np_, note in zip(rendered, notes):
            vel_gt = note[5] if len(note) > 5 else 100.0
            if (np_.ms_on is None or not math.isfinite(np_.ms_on)
                    or not math.isfinite(np_.velocity)):
                bad += 1
                continue
            se_ms += (np_.ms_on - note[3]) ** 2
            se_v += (np_.velocity - vel_gt) ** 2
            n += 1
        out[name + "render_rmse"] = math.sqrt(se_ms / n) if n else float("nan")
        out[name + "vel_rmse"] = math.sqrt(se_v / n) if n else float("nan")
        out[name + "n_nonfinite"] = bad

    gt_tempo = rec.get("tempo") or []
    out["boundary_f1"] = boundary_prf(pred_tempo, gt_tempo)[2] if gt_tempo else 0.0
    gt_rub = rec.get("rubato") or []
    pred_openers = [r for r in pred_rubato if r[2] != 1.0]
    gt_openers = [r for r in gt_rub if r[2] != 1.0]
    out["rubato_f1"] = boundary_prf(pred_openers, gt_openers)[2] if gt_openers else (
        1.0 if not pred_openers else 0.0)
    gt_artic = rec.get("articulation") or []
    out["artic_f1"] = boundary_prf(pred_artic, gt_artic, tol_ticks=90)[2] if gt_artic else (
        1.0 if not pred_artic else 0.0)
    out["n_pred"] = len(pred_tempo)
    out["n_gt"] = len(gt_tempo)
    # MDL efficiency (Team B rec #1): tokens(pred)/tokens(GT); >1 = over-segmentation,
    # <1 = under-explanation. Healthy predictions sit in [0.9, 1.2].
    try:
        from dsl import encode_piece_v3
        dl_pred = len(encode_piece_v3(pred_tempo, pred_dyn, pred_artic, pred_rubato))
        dl_gt = len(encode_piece_v3(gt_tempo, rec.get("dynamics") or [],
                                    rec.get("articulation") or [], rec.get("rubato") or []))
        out["mdl_ratio"] = dl_pred / dl_gt if dl_gt else float("nan")
    except (ValueError, KeyError):
        out["mdl_ratio"] = float("nan")
    return out


# ---------- v2: dynamics ----------

def velocity_render_rmse(pred_dyn, rec):
    """Velocity RMSE per note of the predicted dynamics map vs actual velocities."""
    from dynamics_math import DynamicsTimeline
    tl = DynamicsTimeline(pred_dyn)
    se = n = 0
    for note in rec["notes"]:
        vel = note[5] if len(note) > 5 else 100.0
        e = tl.velocity_at(note[0]) - vel
        se += e * e
        n += 1
    return math.sqrt(se / n)


def evaluate_piece_v2(pred_tempo, pred_dyn, rec):
    out = evaluate_piece(pred_tempo, rec)
    if not pred_dyn or pred_dyn[0][0] != 0:
        pred_dyn = [[0, 100.0, None, None, None]] + [d for d in pred_dyn if d[0] > 0]
    vels = [n[5] if len(n) > 5 else 100.0 for n in rec["notes"]]
    mean_v = sum(vels) / len(vels)
    out["vel_rmse"] = velocity_render_rmse(pred_dyn, rec)
    out["base_vel_rmse"] = math.sqrt(sum((v - mean_v) ** 2 for v in vels) / len(vels))
    gt_dyn = rec.get("dynamics", [])
    out["dyn_boundary_f1"] = boundary_prf(pred_dyn, gt_dyn)[2] if gt_dyn else 0.0
    out["n_dyn_pred"] = len(pred_dyn)
    out["n_dyn_gt"] = len(gt_dyn)
    return out


# ---------- v4: two parts, pedal and asynchrony, via PerfChainV4 ----------

# `_record_parts` rather than a local re-implementation: it is the adapter validate_v4's
# bit-exactness proofs run through, it understands both articulation schemas (3-wide global,
# 4-wide part-local) and it places the asynchronyMap on the last part per sampler rule AS0.
# A second copy of that logic here would be a second thing to keep true.
import bisect  # noqa: E402

from asynchrony_math import AsynchronyTimeline  # noqa: E402
from perf_chain_v4 import PerfChainV4  # noqa: E402
from validate_v4 import _js_round, _record_parts  # noqa: E402,PLC2701

#: MIDI's sustain threshold. CC >= 64 is "pedal down" on every synth that implements the
#: switch reading, so agreement on the *side* of it is what a listener would notice; CC RMSE
#: alone under-reports a prediction that tracks the ramps but sits on the wrong side.
CC64_THRESHOLD = 64


def _v4_record(rec, maps):
    """A record shaped like the generator's, with ``maps`` substituted for its own."""
    out = {k: rec.get(k) for k in ("notes", "total_ticks", "sustain_cc")}
    out.update(maps)
    return out


def _v4_render(rec, maps):
    """(notes in record order, part-1 sustain points) or None if the chain refuses.

    "Record order" has to be taken literally, and used to not be. ``PerfChainV4.render()``
    returns one ``PartPerf`` per part, so flattening it yields notes **part-major**, and the
    caller zips that against ``rec["notes"]`` -- which is part-major only in the generator's
    raw JSONL. ``preprocess.py --eval`` stores its note tensor sorted by ``(date, pitch,
    part)``, because that is the order the features and the per-note labels are indexed in
    (``dataset.piece_to_features_v4``). On a 2-part piece the two orders differ, so every
    metric zipped from them compared part-1 renders against part-2 ground truth: fed the
    **ground truth maps**, a preprocessed 2-part record scored render RMSE 8064 ms and
    velocity RMSE 8.8 where the floor is exactly 0.0. Every v4 training metric measured
    through `train.py`'s eval path carries that error; the pilot gate's `--gt-floor` check
    did not see it because it reads the raw JSONL, where the two orders coincide.

    So the rendered notes are re-keyed onto the record's own rows here. ``_record_parts``
    partitions ``rec["notes"]`` by part preserving each part's internal order, which is what
    makes "the j-th part-p row rendered as the j-th note of part p" exact rather than
    approximate. A row with no rendered counterpart comes back as ``None`` and the caller
    counts it as non-finite.
    """
    try:
        gmaps, specs, _refs, _keys, _raw = _record_parts(_v4_record(rec, maps))
        parts = PerfChainV4(specs, global_maps=gmaps).render()
    except (ValueError, TypeError, KeyError, IndexError, ZeroDivisionError):
        return None
    by_number = {p.number: p.notes for p in parts}
    cursor = {}
    notes = []
    for row in rec["notes"]:
        number = row[6] if len(row) > 6 else 1
        k = cursor.get(number, 0)
        cursor[number] = k + 1
        seq = by_number.get(number) or []
        notes.append(seq[k] if k < len(seq) else None)
    stream = parts[0].stream(kind="position", controller="sustain") if parts else None
    cc = [(p.ms, _js_round(p.value)) for p in stream.points] if stream else []
    return notes, cc


def _cc_steps(cc_rows):
    """``(times, values)`` -- one value per distinct timestamp, last wins (CANONICAL M8/H2).

    A raw stream is not a function of time: ``getMovementSegment`` emits both endpoints of
    every segment at the same millisecond and a plateau emits three coincident points, so
    ~37 % of synthetic timestamps are duplicated and carry *different* values. Collapsing
    them last-wins is what MIDI controller state means, and is what makes the two streams
    below comparable at all."""
    times, values = [], []
    for ms, value in sorted(cc_rows, key=lambda r: r[0]):    # stable: ties keep file order
        if times and times[-1] == ms:
            values[-1] = float(value)
        else:
            times.append(float(ms))
            values.append(float(value))
    return times, values


def _cc_metrics(pred_cc, gt_cc, t_end):
    """Time-weighted CC RMSE and CC-64 threshold agreement over two zero-order-hold streams.

    The streams do not share timestamps -- a predicted movementMap with different segment
    boundaries emits a different number of points at different times -- so neither an
    element-wise comparison nor a sampling of one stream on the other's timestamps is
    well defined (the latter is also asymmetric, and on a stream with duplicate timestamps
    it compares a point against the value that superseded it: fed the ground truth back it
    reported 17-23 cc of error, which is how this was found). Both are step functions, so
    the exact integrals

        RMSE = sqrt( 1/T * integral (pred(t) - gt(t))^2 dt )
        agree = 1/T * |{ t : (pred(t) >= 64) == (gt(t) >= 64) }|

    are computed on the union of their breakpoints, in closed form and in O(n). Fed the
    ground truth, both floor exactly: 0.0 and 1.0.

    CC-64 agreement is reported alongside the RMSE because RMSE alone under-reports a
    prediction that tracks the ramps but sits on the wrong side of the sustain switch --
    which is the half of the signal a listener actually hears.
    """
    if not gt_cc:
        return float("nan"), float("nan")
    tg, vg = _cc_steps(gt_cc)
    tp, vp = _cc_steps(pred_cc) if pred_cc else ([], [])
    t0 = min([tg[0]] + ([tp[0]] if tp else []) + [0.0])
    t1 = max([tg[-1]] + ([tp[-1]] if tp else []) + [t_end or 0.0])
    if not (t1 > t0):
        return float("nan"), float("nan")

    def state(times, values, t):
        if not times:
            return 0.0                       # no movementMap at all: meico's position 0.0
        i = bisect.bisect_right(times, t)
        return values[i - 1] if i else values[0]   # before the first event: carried-in state

    marks = sorted({t for t in tg if t0 <= t <= t1} | {t for t in tp if t0 <= t <= t1}
                   | {t0, t1})
    # Accumulate the DISAGREEING time and subtract, rather than accumulating the agreeing
    # time and dividing: summing hundreds of segment widths and dividing by the span lands
    # on 0.9999999999999998 for a stream that agrees everywhere, and "the ground truth
    # scores 1.0 exactly" is a property this metric should have rather than nearly have.
    se = disagree = 0.0
    for a, b in zip(marks, marks[1:]):
        width = b - a
        if width <= 0:
            continue
        p = state(tp, vp, a)
        g = state(tg, vg, a)
        se += width * (p - g) ** 2
        if (p >= CC64_THRESHOLD) != (g >= CC64_THRESHOLD):
            disagree += width
    span = t1 - t0
    return math.sqrt(se / span), 1.0 - disagree / span


def _asyn_offset_error(pred_asyn, gt_asyn, total_ticks, step=None):
    """Mean |offset error| in ms over the piece, sampled on a beat grid. Both maps are step
    functions of score date, so this is the L1 distance between two staircases -- the
    quantity Y3's 5 ms deadband and 60 ms cap are stated in."""
    step = step or PPQ
    pred_at = AsynchronyTimeline(pred_asyn or [])
    gt_at = AsynchronyTimeline(gt_asyn or [])
    n = max(1, int((total_ticks or PPQ) // step) + 1)
    return sum(abs(pred_at.offset_at(i * step) - gt_at.offset_at(i * step))
               for i in range(n)) / n


def evaluate_piece_v4(pred_maps, rec):
    """Render-space evaluation of a v4 prediction through the exact two-part meico chain.

    ``pred_maps`` is the decoded map dict (``dsl.V4_MAP_ORDER`` keys); ``rec`` is the
    record, which must carry ``notes`` (7-element), ``total_ticks`` and ``sustain_cc``
    alongside its own maps. Fed the ground-truth maps this returns exactly 0.0 for every
    error metric -- that identity is the floor the whole evaluation rests on, and it is
    checked rather than assumed (``--gt-floor`` in the pilot gate).

    Non-finite renders are counted into ``n_nonfinite`` and excluded from the RMSEs instead
    of poisoning an epoch median.
    """
    from dsl import V4_MAP_ORDER

    pred = {k: list(pred_maps.get(k) or []) for k in V4_MAP_ORDER}
    if not pred["tempo"] or pred["tempo"][0][0] != 0:
        pred["tempo"] = [[0, 100.0, None, None]] + [t for t in pred["tempo"] if t[0] > 0]
    if not pred["dynamics"] or pred["dynamics"][0][0] != 0:
        pred["dynamics"] = ([[0, 100.0, None, None, None]]
                            + [d for d in pred["dynamics"] if d[0] > 0])

    notes = rec["notes"]
    gt_cc = [(ms, float(v)) for ms, v in (rec.get("sustain_cc") or [])]
    total_ticks = rec.get("total_ticks") or max(n[0] + n[1] for n in notes)
    gt_maps = {k: rec.get(k) or [] for k in V4_MAP_ORDER}

    out = {}
    for name, maps in (("", pred), ("base_", {**{k: [] for k in V4_MAP_ORDER},
                                              "tempo": constant_baseline(rec)})):
        rendered = _v4_render(rec, maps)
        if rendered is None:
            out[name + "render_rmse"] = float("nan")
            out[name + "off_rmse"] = float("nan")
            out[name + "vel_rmse"] = float("nan")
            out[name + "cc_rmse"] = float("nan")
            out[name + "cc64_agree"] = float("nan")
            out[name + "n_nonfinite"] = len(notes)
            continue
        got_notes, got_cc = rendered
        se_ms = se_off = se_v = n = bad = 0
        for np_, note in zip(got_notes, notes):
            vel_gt = note[5] if len(note) > 5 else 100.0
            if (np_ is None or np_.ms_on is None or not math.isfinite(np_.ms_on)
                    or np_.ms_off is None or not math.isfinite(np_.ms_off)
                    or np_.velocity is None or not math.isfinite(np_.velocity)):
                bad += 1
                continue
            se_ms += (np_.ms_on - note[3]) ** 2
            se_off += (np_.ms_off - note[4]) ** 2
            se_v += (np_.velocity - vel_gt) ** 2
            n += 1
        out[name + "render_rmse"] = math.sqrt(se_ms / n) if n else float("nan")
        # Note-OFF error is the only render-space metric articulation's relativeDuration can
        # move: `ArticulationData.articulateNote` scales `duration.perf` and shifts velocity,
        # and touches the onset not at all. Without it the articulation head's relDur output
        # would be invisible to every number this evaluator reports.
        out[name + "off_rmse"] = math.sqrt(se_off / n) if n else float("nan")
        out[name + "vel_rmse"] = math.sqrt(se_v / n) if n else float("nan")
        t_end = max((n[4] for n in notes), default=0.0)
        cc_rmse, cc64 = _cc_metrics(got_cc, gt_cc, t_end)
        out[name + "cc_rmse"] = cc_rmse
        out[name + "cc64_agree"] = cc64
        out[name + "n_nonfinite"] = bad

    out["asyn_offset_err"] = _asyn_offset_error(pred["asynchrony"], gt_maps["asynchrony"],
                                                total_ticks)
    out["base_asyn_offset_err"] = _asyn_offset_error([], gt_maps["asynchrony"], total_ticks)
    out["boundary_f1"] = (boundary_prf(pred["tempo"], gt_maps["tempo"])[2]
                          if gt_maps["tempo"] else 0.0)
    out["dyn_boundary_f1"] = (boundary_prf(pred["dynamics"], gt_maps["dynamics"])[2]
                              if gt_maps["dynamics"] else 0.0)
    pred_openers = [r for r in pred["rubato"] if r[2] != 1.0]
    gt_openers = [r for r in gt_maps["rubato"] if r[2] != 1.0]
    out["rubato_f1"] = (boundary_prf(pred_openers, gt_openers)[2] if gt_openers
                        else (1.0 if not pred_openers else 0.0))
    out["n_pred"] = len(pred["tempo"])
    out["n_gt"] = len(gt_maps["tempo"])
    # MDL on the FULL DSL: the description length of a v4 performance is what CANONICAL §11
    # prices, and the training target is a subset of it. Measuring the ratio on the subset
    # would score the model against a representation nobody exports.
    try:
        from dsl import encode_piece_v4
        dl_pred = len(encode_piece_v4({**gt_maps, **pred}, subset="full"))
        dl_gt = len(encode_piece_v4(gt_maps, subset="full"))
        out["mdl_ratio"] = dl_pred / dl_gt if dl_gt else float("nan")
    except (ValueError, KeyError):
        out["mdl_ratio"] = float("nan")
    return out
