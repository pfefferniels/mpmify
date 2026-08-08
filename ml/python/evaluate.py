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
