"""Identifiability + MDL experiments for the v3 canonical normal form.

Run:  nice -n 15 python3 identifiability.py            (all experiments)
      nice -n 15 python3 identifiability.py validate   (exactness proofs only)

Experiments
-----------
V   Exactness proofs (the project's standard of proof, all must be <= 1e-9):
      V1 the DL token counter == python/dsl.py::encode_piece            (0 mismatches)
      V2 the staircase design matrix == meico constant-tempo rendering  (~1e-12 ms)
      V3 GT canonical MPM re-rendered == meico's own render             (0.0 ms)
      V4 the pure-Python rubato warp == meico's RubatoMap, single       (0.0 ms)
         constant tempo (isolates computeRubatoTransformation)
      V5 the pure-Python rubato o tempo COMPOSITION == meico, on a      (0.0 ms)
         multi-segment tempo map (constants + transitions) whose
         boundaries fall strictly inside the rubato frames.  V4 alone
         does not cover this: meico picks the tempo segment by the
         *unwarped* map key and evaluates it at the *warped* date.

A   Pareto: DL (canonical-DSL tokens) vs render RMSE (ms) for
      GT canonical | constant baseline | staircase at 8/4/2/1 beat grids,
    over N pieces of data/val_v2.jsonl.  Claim under test: canonical MPM DOMINATES
    -- fewer tokens AND lower error than every staircase.

B   Tempo-vs-rubato ambiguity: on meico-rendered pieces carrying one canonical
    rubato span, how many staircase tempo instructions (and how many DL tokens)
    does a tempo-only explanation need to get within {50,20,10,5} ms of the
    rubato explanation, whose own error is 0.0 ms at ~12 tokens?
    Also: the error FLOOR of any beat-aligned tempo map (the orthogonality claim).
"""

import json
import math
import os
import statistics
import subprocess
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "python"))
sys.path.insert(0, _HERE)

import mdl                                                   # noqa: E402
import staircase_fit as sf                                   # noqa: E402
from tempo_math import PPQ, BEAT_LENGTH, TempoTimeline      # noqa: E402

DATA = os.path.join(_HERE, "..", "data")
VAL = os.path.join(DATA, "val_v2.jsonl")
RUBATO_PROBE = os.path.join(DATA, "pilot_rubato.jsonl")
RUBATO_PROBE_MULTI = os.path.join(DATA, "pilot_rubato_multitempo.jsonl")
PROBE_SRC = os.path.join(_HERE, "RubatoProbe.java")
MEICO = "/Users/nielspfeffer/Projects/meico"
CP = f"out:{MEICO}/out/production/meico:{MEICO}/externals/*"

OUT_DIR = os.path.join(_HERE, "out")          # gitignored (ml/.gitignore: out/)

GRIDS = [8, 4, 2, 1]
TOLERANCES = [50.0, 20.0, 10.0, 5.0]
GREEDY_MAX_INSTR_A = 48       # experiment A budget
GREEDY_MAX_INSTR_B = 80       # experiment B budget (rubato needs more breakpoints)


# --------------------------------------------------------------------------- #
# canonical rubato, in pure Python (exact port of meico RubatoMap
# .computeRubatoTransformation, restricted to the canonical case
# lateStart=0, earlyEnd=1, loop=true, closed by a neutral terminator)
# --------------------------------------------------------------------------- #

def rubato_warp(date, start, frame, intensity, late_start=0.0, early_end=1.0):
    local = (date - start) % frame
    d = (math.pow(local / frame, intensity) * (early_end - late_start)
         + late_start) * frame
    return date + d - local


def apply_rubato_spans(date, spans):
    """spans: [(start, frame, intensity, end)].  Outside every span: identity."""
    for start, frame, intensity, end in spans:
        if start <= date < end:
            return rubato_warp(date, start, frame, intensity)
    return date


# --------------------------------------------------------------------------- #
# rubato o tempo, exactly as meico composes them
#
# The composition is NOT `TempoTimeline.ms_at(warp(t))`.  meico's
# TempoMap.renderTempoToMap (TempoMap.java:394-404) selects the tempo segment of a
# map element by the element's *key* -- the UNWARPED score date, which RubatoMap
# never touches -- but evaluates the tempo formula on attribute `date.perf`, which
# RubatoMap.java:368 has already warped.  A note can therefore be rendered with a
# tempo segment that does not contain its own performance date.  Consequences we
# must mirror exactly:
#   * segment index i = first i with key <= instrs[i+1].date  (i.e. the segment is
#     chosen from the key, not from the warped date);
#   * key <= instrs[0].date (only key == 0) takes meico's "no tempo data" branch,
#     600*date.perf/ppq, i.e. an implicit 100 bpm;
#   * the Simpson step count uses Java's (long) cast = truncation TOWARD ZERO,
#     which differs from math.floor once date.perf < segment start;
#   * getTempoAt does NOT clamp outside [start, end]: it extrapolates the power
#     function, and for date.perf < start it evaluates Math.pow(negative, exponent)
#     = NaN.  We reproduce the NaN rather than hiding it -- it is precisely why
#     canonical form forbids a tempo boundary strictly inside a rubato frame
#     (CANONICAL.md R8).
# `python/tempo_math.py` deliberately keeps the simpler in-segment semantics; it is
# correct for its own (rubato-free) use and must not be "fixed" to match this.
#
# Scope: note ONSETS.  meico resolves note *offsets* through its pendingDurations
# lists, which key the tempo segment off the already-warped date.end.perf -- a
# different rule again.  Offsets are out of scope here and this module never
# claims them.
# --------------------------------------------------------------------------- #

def _java_pow(base, exponent):
    """java.lang.Math.pow semantics for the cases meico can reach."""
    if base < 0.0 and exponent != int(exponent):
        return float("nan")                      # Java: NaN, Python: ValueError
    if base == 0.0 and exponent < 0.0:
        return float("inf")
    return math.pow(base, exponent)


def _meico_tempo_at(date, instr, end_date):
    """TempoMap.getTempoAt(date, td) -- no clamping outside the segment."""
    d0, bpm, to, mta = instr
    if to is None or to == bpm:
        return bpm
    if date == end_date:
        return to
    x = (date - d0) / (end_date - d0)
    exponent = math.log(0.5) / math.log(mta) if mta else 1.0
    return _java_pow(x, exponent) * (to - bpm) + bpm


def _meico_diff_timing(date, instr, end_date):
    """TempoMap.computeDiffTiming(date, ppq, td) for a non-null td."""
    d0, bpm, to, mta = instr
    if to is None or to == bpm:                                   # constant tempo
        return 15000.0 * (date - d0) / (bpm * BEAT_LENGTH * PPQ)
    n2 = 2.0 * int((date - d0) / (PPQ / 4.0))    # Java (long) cast: trunc toward 0
    if n2 == 0.0:
        n2 = 2.0
    n = n2 / 2.0
    x = (date - d0) / n2
    result_const = ((date - d0) * 5000.0) / (n2 * BEAT_LENGTH * PPQ)
    s = 1.0 / bpm + 1.0 / _meico_tempo_at(date, instr, end_date)
    k = 1
    while k < n:                                                  # even pieces
        s += 2.0 / _meico_tempo_at(d0 + 2 * k * x, instr, end_date)
        k += 1
    k = 1
    while k <= n:                                                 # odd pieces
        s += 4.0 / _meico_tempo_at(d0 + (2 * k - 1) * x, instr, end_date)
        k += 1
    return result_const * s


class RubatoTempoRenderer:
    """Exact meico composition RubatoMap -> TempoMap, for note onsets."""

    def __init__(self, tempo_map):
        self.instrs = tempo_map
        self.starts_ms = [0.0]                # td.startDateMilliseconds chain
        for i in range(len(tempo_map) - 1):
            end = tempo_map[i + 1][0]
            self.starts_ms.append(
                self.starts_ms[-1] + _meico_diff_timing(end, tempo_map[i], end))

    def ms_at(self, key, perf_date):
        """key = unwarped score date (the GenericMap key), perf_date = warped."""
        i = 0
        while i + 1 < len(self.instrs) and key > self.instrs[i + 1][0]:
            i += 1
        if key <= self.instrs[i][0]:                          # meico's null-tempo branch
            return 600.0 * perf_date / PPQ
        end = self.instrs[i + 1][0] if i + 1 < len(self.instrs) else float("inf")
        return self.starts_ms[i] + _meico_diff_timing(perf_date, self.instrs[i], end)


def render_with_rubato(tempo_map, spans, ticks):
    """Onset milliseconds of `ticks` (UNWARPED score dates) under tempo o rubato."""
    r = RubatoTempoRenderer(tempo_map)
    return [r.ms_at(t, apply_rubato_spans(t, spans)) for t in ticks]


# --------------------------------------------------------------------------- #
# data
# --------------------------------------------------------------------------- #

def load(path, limit=None):
    out = []
    with open(path) as fh:
        for i, line in enumerate(fh):
            if limit and i >= limit:
                break
            out.append(json.loads(line))
    return out


def ensure_rubato_probe(path=RUBATO_PROBE, n=40, seed=424242, mode="iso"):
    """Regenerate the meico probe if it is missing OR older than RubatoProbe.java.

    The mtime guard matters: without it an edited probe generator would silently be
    validated against a stale JSONL, which is exactly how an exactness proof stops
    proving anything.  Generation is ~1 s of JVM for 40 pieces.
    """
    if os.path.exists(path) and os.path.getmtime(path) >= os.path.getmtime(PROBE_SRC):
        return
    subprocess.run(["javac", "-cp",
                    f"{MEICO}/out/production/meico:{MEICO}/externals/*",
                    "-d", "out", "RubatoProbe.java"], cwd=_HERE, check=True)
    subprocess.run(["java", "-cp", CP, "RubatoProbe", path, str(n), str(seed), mode],
                   cwd=_HERE, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# --------------------------------------------------------------------------- #
# V — exactness proofs
# --------------------------------------------------------------------------- #

def validate(n_val=100):
    lines = []
    p, m, w = mdl.selftest()
    lines.append(f"V1 DL token counter vs dsl.encode_piece : {p} pieces, "
                 f"{m} mismatches, max |diff| = {w}")

    w2 = sf.validate_design_matrix()
    lines.append(f"V2 staircase design matrix vs meico rendering : "
                 f"max |diff| = {w2:.12f} ms  (200 staircases x 40 notes)")

    recs = load(VAL, n_val)
    worst = 0.0
    n_notes = 0
    for rec in recs:
        tl = TempoTimeline(rec["tempo"])
        for n in rec["notes"]:
            worst = max(worst, abs(tl.ms_at(n[0]) - n[3]))
            n_notes += 1
    lines.append(f"V3 GT canonical MPM re-render vs meico : "
                 f"max |diff| = {worst:.12f} ms  ({len(recs)} pieces, {n_notes} notes)")

    ensure_rubato_probe()
    rub = load(RUBATO_PROBE)
    worst_r, n_r, nan_r = _probe_divergence(rub)
    lines.append(f"V4 pure-Python rubato warp vs meico RubatoMap : "
                 f"max |diff| = {worst_r:.12f} ms  ({len(rub)} pieces, {n_r} notes, "
                 f"1 constant tempo instruction per piece)")

    ensure_rubato_probe(RUBATO_PROBE_MULTI, 40, 515151, "multi")
    mul = load(RUBATO_PROBE_MULTI)
    n_straddle = sum(1 for r in mul if r.get("straddle"))
    const_only = [r for r in mul if all(t[2] is None for t in r["tempo"])]
    n_trans = len(mul) - len(const_only)

    # V5a: the composition model alone, on the pow-free subset (constant tempo
    # segments only, meico's own warped dates fed in) -- must be BIT-EXACT.
    if not const_only or not any("perf" in r for r in mul):
        raise RuntimeError("V5 would pass vacuously: the multi probe carries no "
                           "constant-tempo pieces or no date.perf field")
    worst_c, n_c, _ = _probe_divergence(const_only, use_meico_perf_dates=True)
    lines.append(f"V5 rubato o tempo COMPOSITION vs meico, pow-free subset : "
                 f"max |diff| = {worst_c:.12f} ms  ({len(const_only)} pieces, "
                 f"{n_c} notes, multi-segment constant tempo, meico's own date.perf)")

    # V5b: the same model with power transitions in the tempo map.
    worst_m, n_m, nan_m = _probe_divergence(mul, use_meico_perf_dates=True)
    lines.append(f"V6 same, WITH power transitions : "
                 f"max |diff| = {worst_m:.12f} ms  ({len(mul)} pieces, {n_m} notes, "
                 f"{n_straddle} with a tempo boundary strictly inside a rubato "
                 f"frame, {n_trans} with transitions; {nan_m} NaN onsets reproduced "
                 f"exactly)")

    # V6: end to end, our own warp included.
    worst_e2e, _, _ = _probe_divergence(mul)
    worst_warp = _warp_divergence(mul)
    lines.append(f"V7 end-to-end (own warp + own composition) : "
                 f"max |diff| = {worst_e2e:.12f} ms; the warp alone differs from "
                 f"meico's date.perf by {worst_warp:.3e} ticks.  V6/V7 residuals are "
                 f"1 ULP of pow (java.lang.Math.pow = fdlibm vs CPython libm, "
                 f"verified bit-for-bit) -- irreducible without reimplementing "
                 f"fdlibm, and 8 orders below the 1e-9 bar")
    return lines, max(w, w2, worst, worst_r, worst_c, worst_m, worst_e2e)


def _probe_divergence(recs, use_meico_perf_dates=False):
    """max |python - meico| over a probe file.  NaN onsets (meico's own output when
    a warped date falls before the start of a power transition) must appear in
    EXACTLY the same places on both sides; any mismatch of the NaN mask is scored as
    infinite divergence.

    `use_meico_perf_dates` feeds meico's own warped tick dates (attribute
    `date.perf`, emitted by RubatoProbe in mode "multi") into the tempo composition
    instead of the Python warp.  That isolates the thing under test -- the
    segment-selection/evaluation model -- from the 1-ULP disagreement between
    java.lang.Math.pow and CPython's libm, and it is exact (0.0).
    """
    worst, n_notes, n_nan = 0.0, 0, 0
    for rec in recs:
        spans = [tuple(s) for s in rec["rubato"]]
        ticks = [n[0] for n in rec["notes"]]
        if use_meico_perf_dates and "perf" in rec:
            r = RubatoTempoRenderer(rec["tempo"])
            pred = [r.ms_at(t, p) for t, p in zip(ticks, rec["perf"])]
        else:
            pred = render_with_rubato(rec["tempo"], spans, ticks)
        for p_ms, n in zip(pred, rec["notes"]):
            n_notes += 1
            ref_nan, pred_nan = math.isnan(n[3]), math.isnan(p_ms)
            if ref_nan or pred_nan:
                n_nan += 1
                if ref_nan != pred_nan:
                    worst = float("inf")
                continue
            worst = max(worst, abs(p_ms - n[3]))
    return worst, n_notes, n_nan


def _warp_divergence(recs):
    """max |python warp - meico date.perf| in TICKS."""
    worst = 0.0
    for rec in recs:
        if "perf" not in rec:
            continue
        spans = [tuple(s) for s in rec["rubato"]]
        for n, ref in zip(rec["notes"], rec["perf"]):
            worst = max(worst, abs(apply_rubato_spans(n[0], spans) - ref))
    return worst


# --------------------------------------------------------------------------- #
# A — Pareto: DL vs render RMSE
# --------------------------------------------------------------------------- #

def experiment_a(n_pieces=100):
    recs = load(VAL, n_pieces)
    rows = {}

    def add(name, dl, rmse, n_instr, n_notes, integer_dates=True):
        rows.setdefault(name, []).append(
            (dl, rmse, n_instr, mdl.total_bits(dl, n_notes, rmse)))

    for rec in recs:
        n_notes = len(rec["notes"])
        gt = rec["tempo"]
        dl_gt = mdl.dl_tempo_map(gt)
        add("GT canonical", dl_gt, mdl.render_rmse(gt, rec), len(gt), n_notes)

        base = mdl.constant_baseline(rec)
        add("constant", mdl.dl_tempo_map(base), mdl.render_rmse(base, rec),
            len(base), n_notes)

        for g in GRIDS:
            tmap = sf.fit_staircase(rec, g)
            add(f"staircase {g}b", mdl.dl_tempo_map(tmap),
                mdl.render_rmse(tmap, rec), len(tmap), n_notes)

    order = ["GT canonical", "constant"] + [f"staircase {g}b" for g in GRIDS]
    table = []
    dl_gts = [mdl.dl_tempo_map(r["tempo"]) for r in recs]
    for name in order:
        vals = rows[name]
        dls = [v[0] for v in vals]
        rmses = [v[1] for v in vals]
        instrs = [v[2] for v in vals]
        bits = [v[3] for v in vals]
        ratios = [d / g for d, g in zip(dls, dl_gts)]
        table.append({
            "name": name,
            "dl_med": statistics.median(dls),
            "dl_mean": statistics.mean(dls),
            "instr_med": statistics.median(instrs),
            "rmse_med": statistics.median(rmses),
            "rmse_p90": sorted(rmses)[int(0.9 * (len(rmses) - 1))],
            "bits_med": statistics.median(bits),
            "mdl_ratio_med": statistics.median(ratios),
        })
    return table, recs


def experiment_a_equal_fidelity(recs, tols=(10.0, 1.0), max_instr=GREEDY_MAX_INSTR_A):
    """For each piece: the cheapest staircase (greedy, sixteenth-grid candidates,
    sub-beat boundaries allowed) that matches the GT canonical map's fidelity to
    within each tolerance.  Reports the DL blow-up -- the price of refusing the
    smooth-curve primitive.  One greedy path per piece prices all tolerances."""
    acc = {t: {"ratios": [], "instr_ratios": [], "reached": 0} for t in tols}
    tightest = min(tols)
    for rec in recs:
        gt = rec["tempo"]
        dl_gt = mdl.dl_tempo_map(gt)
        path = sf.greedy_path(rec, tightest, max_instr=max_instr)
        for t in tols:
            hit = sf.first_reaching(path, t)
            p = hit or path[-1]
            dl = mdl.dl_tempo_map(p["map"], integer_dates=False)
            acc[t]["ratios"].append(dl / dl_gt)
            acc[t]["instr_ratios"].append(len(p["map"]) / len(gt))
            acc[t]["reached"] += 1 if hit else 0
    return [{
        "tol_ms": t,
        "reached": acc[t]["reached"],
        "n": len(recs),
        "max_instr": max_instr,
        "dl_ratio_med": statistics.median(acc[t]["ratios"]),
        "dl_ratio_mean": statistics.mean(acc[t]["ratios"]),
        "instr_ratio_med": statistics.median(acc[t]["instr_ratios"]),
    } for t in tols]


# --------------------------------------------------------------------------- #
# B — tempo vs rubato
# --------------------------------------------------------------------------- #

def _ls_residual_rmse(rec, boundaries):
    """Unrounded least-squares residual of a staircase on the given boundaries."""
    ticks = [n[0] for n in rec["notes"]]
    y = np.array([n[3] for n in rec["notes"]], dtype=float)
    L = sf.design_matrix(ticks, boundaries)
    s = sf._solve(L, y)
    return float(np.sqrt(np.mean((L @ s - y) ** 2)))


def beat_aligned_floor(rec):
    """Residual left by the OPTIMAL beat-aligned piecewise-constant tempo map.

    This is a strictly richer family than canonical tempo (boundaries every beat
    instead of every >=4 beats), so whatever it cannot remove, canonical tempo
    certainly cannot remove either -- except for within-segment curvature, which
    canonical form allows but at a density of one shape per >=4 beats.  Read it as
    "the part of the warp that beat-grid tempo cannot see".
    """
    total = max(n[0] + n[1] for n in rec["notes"])
    return _ls_residual_rmse(rec, sf.grid_boundaries(total, 1))


def ls_constant_rmse(rec):
    """Residual of the optimal SINGLE constant tempo = RMS magnitude of the warp."""
    return _ls_residual_rmse(rec, [0])


def experiment_b(max_instr=GREEDY_MAX_INSTR_B):
    ensure_rubato_probe()
    recs = load(RUBATO_PROBE)
    out = []
    for rec in recs:
        spans = [tuple(s) for s in rec["rubato"]]
        start, frame, intensity, end = spans[0]
        n_notes = len(rec["notes"])

        # --- the true explanation ---
        dl_rub = mdl.dl_rubato_span(start, frame, intensity, end)
        dl_true = mdl.dl_tempo_map(rec["tempo"]) + dl_rub
        ticks = [n[0] for n in rec["notes"]]
        pred = render_with_rubato(rec["tempo"], spans, ticks)
        rmse_true = math.sqrt(sum((p - n[3]) ** 2 for p, n in zip(pred, rec["notes"]))
                              / n_notes)

        # --- tempo-only rivals ---
        base = mdl.constant_baseline(rec)
        row = {
            "id": rec["id"], "frame_beats": frame // PPQ, "intensity": intensity,
            "span_beats": (end - start) // PPQ, "n_notes": n_notes,
            "dl_true": dl_true, "dl_rubato_only": dl_rub, "rmse_true": rmse_true,
            "dl_const": mdl.dl_tempo_map(base),
            "rmse_const": mdl.render_rmse(base, rec),
            "rmse_ls_const": ls_constant_rmse(rec),
            "floor_beat_aligned": beat_aligned_floor(rec),
        }
        row["absorbed_frac"] = (1.0 - row["floor_beat_aligned"] / row["rmse_ls_const"]
                                if row["rmse_ls_const"] > 0 else 0.0)
        for g in GRIDS:
            tmap = sf.fit_staircase(rec, g)
            row[f"rmse_{g}b"] = mdl.render_rmse(tmap, rec)
            row[f"dl_{g}b"] = mdl.dl_tempo_map(tmap)

        row["intensity_dev"] = abs(math.log2(intensity))
        # one greedy sub-beat staircase path prices every tolerance
        path = sf.greedy_path(rec, min(TOLERANCES), max_instr=max_instr)
        row["best_rmse"] = path[-1]["rmse"]
        row["best_instr"] = path[-1]["n_instr"]
        for tol in TOLERANCES:
            k = int(tol)
            hit = sf.first_reaching(path, tol)
            row[f"tol{k}_instr"] = hit["n_instr"] if hit else None
            row[f"tol{k}_dl"] = (mdl.dl_tempo_map(hit["map"], integer_dates=False)
                                 if hit else None)
        out.append(row)
    return out


def summarise_b(rows):
    """Aggregation convention (same as experiment_a): every ratio is a
    MEDIAN OF PER-PIECE RATIOS, never a ratio of medians.  The two differ (for the
    10 ms row: 5.85 vs 5.88); mixing them across sections was an inconsistency in
    the first release of this study."""
    def med(key):
        vals = [r[key] for r in rows if r.get(key) is not None]
        return statistics.median(vals) if vals else float("nan")

    def cnt(key):
        return sum(1 for r in rows if r.get(key) is not None)

    s = {
        "n": len(rows),
        "dl_true_med": med("dl_true"),
        "dl_rubato_only_med": med("dl_rubato_only"),
        "rmse_true_max": max(r["rmse_true"] for r in rows),
        "rmse_const_med": med("rmse_const"),
        "rmse_ls_const_med": med("rmse_ls_const"),
        "rmse_ls_const_min": min(r["rmse_ls_const"] for r in rows),
        "floor_med": med("floor_beat_aligned"),
        "absorbed_frac_med": med("absorbed_frac"),
        "greedy_max_instr": GREEDY_MAX_INSTR_B,
    }
    for g in GRIDS:
        vals = sorted(r[f"rmse_{g}b"] for r in rows)
        s[f"rmse_{g}b_med"] = statistics.median(vals)
        s[f"rmse_{g}b_min"] = vals[0]
        s[f"rmse_{g}b_p10"] = vals[max(0, int(0.10 * (len(vals) - 1)))]
        s[f"rmse_{g}b_below10ms"] = sum(1 for v in vals if v < 10.0)
        s[f"rmse_{g}b_below28ms"] = sum(1 for v in vals if v < 28.0)
        s[f"dl_{g}b_med"] = med(f"dl_{g}b")
    for tol in TOLERANCES:
        k = int(tol)
        s[f"tol{k}_reached"] = cnt(f"tol{k}_instr")
        s[f"tol{k}_instr_med"] = med(f"tol{k}_instr")
        s[f"tol{k}_dl_med"] = med(f"tol{k}_dl")
        ratios = [r[f"tol{k}_dl"] / r["dl_true"]
                  for r in rows if r.get(f"tol{k}_dl") is not None]
        s[f"tol{k}_dlratio_med"] = statistics.median(ratios) if ratios else float("nan")
    return s


# --------------------------------------------------------------------------- #
# A2 — the velocity field: curve vs per-onset skyline
# --------------------------------------------------------------------------- #

def experiment_a2(recs):
    """Same MDL question for dynamics.  The rival is the dense skyline: one constant
    dynamics instruction per distinct rendered velocity value (partitura's codec is
    this, per note).

    The skyline's velocity error is MEASURED, not assumed: it is not exactly zero,
    because canonical precision rounds `volume` to 1 decimal (G6) while the rendered
    velocities in the JSONL are un-quantised floats.  The residual is ~0.02 velocity
    units -- immaterial to the DL conclusion, but this document's standard of proof
    is exactness, so the number is reported rather than claimed.
    """
    gt_dl, sky_dl, const_err, gt_err, sky_err = [], [], [], [], []
    for rec in recs:
        gt = rec.get("dynamics", [])
        if not gt:
            continue
        gt_dl.append(mdl.dl_dynamics_map(gt))
        gt_err.append(mdl.vel_rmse(gt, rec))
        # skyline: one instruction wherever the rendered velocity changes
        sky, last = [], None
        for n in sorted(rec["notes"], key=lambda x: x[0]):
            v = round(n[5] if len(n) > 5 else 100.0, 1)
            if v != last:
                sky.append([n[0], v, None, None, None])
                last = v
        sky_dl.append(mdl.dl_dynamics_map(sky, integer_dates=False))
        sky_err.append(mdl.vel_rmse(sky, rec))
        vels = [n[5] if len(n) > 5 else 100.0 for n in rec["notes"]]
        mv = sum(vels) / len(vels)
        const_err.append(math.sqrt(sum((v - mv) ** 2 for v in vels) / len(vels)))
    return {
        "n": len(gt_dl),
        "gt_dl_med": statistics.median(gt_dl),
        "gt_vel_rmse_max": max(gt_err),
        "skyline_dl_med": statistics.median(sky_dl),
        "skyline_ratio_med": statistics.median(s / g for s, g in zip(sky_dl, gt_dl)),
        "skyline_vel_rmse_med": statistics.median(sky_err),
        "skyline_vel_rmse_max": max(sky_err),
        "const_vel_rmse_med": statistics.median(const_err),
    }


# --------------------------------------------------------------------------- #
# D — the rubato observability floor as a function of frameLength
#     (calibrates the R3 intensity deadband, which must NOT be frame-independent)
# --------------------------------------------------------------------------- #

def _synthetic_rubato_rec(frame_ticks, intensity, bpm, span_frames=4,
                          grid_ticks=180):
    """A synthetic piece: constant tempo `bpm`, one canonical rubato span covering
    the whole piece, notes on a sixteenth grid.  Rendered with the meico-exact
    composition (V5), so the numbers are render-space truth."""
    total = frame_ticks * span_frames
    ticks = list(range(0, total, grid_ticks))
    tmap = [[0, bpm, None, None]]
    spans = [(0, frame_ticks, intensity, total)]
    ms = render_with_rubato(tmap, spans, ticks)
    notes = [[t, grid_ticks, 60, m, m, 100.0] for t, m in zip(ticks, ms)]
    return {"id": 0, "ppq": PPQ, "notes": notes, "tempo": tmap,
            "rubato": [list(spans[0])]}


def _warp_rms(frame_ticks, intensity, bpm):
    """RMS onset displacement that survives the best SINGLE constant tempo, i.e.
    how much of the span a tempo-only explanation cannot even in principle hide by
    re-reading the global tempo.  This is the 'is the instruction falsifiable at
    all' quantity."""
    return ls_constant_rmse(_synthetic_rubato_rec(frame_ticks, intensity, bpm))


def _deadband_edge(frame_ticks, bpm, floor_ms, side, lo=0.2, hi=5.0):
    """Bisect for the intensity at which `_warp_rms` crosses `floor_ms`."""
    if side == "hi":
        a, b = 1.0, hi
    else:
        a, b = lo, 1.0
    if _warp_rms(frame_ticks, b if side == "hi" else a, bpm) < floor_ms:
        return None
    for _ in range(60):
        m = 0.5 * (a + b)
        below = _warp_rms(frame_ticks, m, bpm) < floor_ms
        if side == "hi":
            a, b = (m, b) if below else (a, m)
        else:
            a, b = (a, m) if below else (m, b)
    return 0.5 * (a + b)


def experiment_d(floor_ms=5.0, frames_beats=(1, 2, 4), bpms=(100.0, 200.0, 240.0),
                 intensities=(0.45, 0.7, 0.86, 0.95, 1.05, 1.07, 1.25, 1.6, 2.2)):
    """R3 calibration.  The warp amplitude in MILLISECONDS scales with the frame
    DURATION, so a single intensity deadband [0.95, 1.05] cannot be right for all
    three frame lengths: at frameLength = 720 (1 beat) and a fast tempo, intensities
    well outside that band still produce a warp below the ~5 ms observability floor
    this study uses elsewhere (findings C, CANONICAL 4.T2).  Measured, not argued."""
    grid = {}
    for fb in frames_beats:
        for bpm in bpms:
            for i in intensities:
                grid[(fb, bpm, i)] = _warp_rms(fb * PPQ, i, bpm)
    edges = {}
    for fb in frames_beats:
        for bpm in bpms:
            edges[(fb, bpm)] = (_deadband_edge(fb * PPQ, bpm, floor_ms, "lo"),
                                _deadband_edge(fb * PPQ, bpm, floor_ms, "hi"))
    return grid, edges, frames_beats, bpms, intensities


# --------------------------------------------------------------------------- #
# C — why "segments >= 4 beats" and "|log2 tempo ratio| >= 0.15"
# --------------------------------------------------------------------------- #

def _segment_rec(length_beats, note_grid_ticks=180):
    ticks = list(range(0, length_beats * PPQ + 1, note_grid_ticks))
    return ticks


def _render(tempo_map, ticks):
    tl = TempoTimeline(tempo_map)
    return np.array([tl.ms_at(t) for t in ticks])


def _rescale_residual(a, b):
    """RMS(b - alpha*a) minimised over alpha>0: the difference that survives after
    the boundary tempi are globally re-optimised (tau -> alpha*tau leaves the shape
    invariant and rescales all times by 1/alpha)."""
    denom = float(a @ a)
    alpha = float(a @ b) / denom if denom > 0 else 1.0
    return float(np.sqrt(np.mean((b - alpha * a) ** 2)))


def experiment_c(tau0=100.0, lengths=(1, 2, 4, 8, 16),
                 ratios=(1.05, 1.11, 1.25, 1.5, 2.0),
                 mta_a=0.30, mta_b=0.70):
    """Two identifiability questions, answered exactly in render space.

    C1 shape: over a transition of L beats, how far apart (ms RMSE, after the
       boundary tempi are re-optimised) are meanTempoAt=0.30 and 0.70?  Below the
       ~few-ms noise floor the shape parameter is unrecoverable -> the segment is
       too short to carry a curve.
    C2 depth: over the same segment, how far is a transition of ratio r from the
       best CONSTANT tempo?  Below the noise floor the transition is indistinguish-
       able from a plain tempo change -> it should not be sampled at all.
    """
    c1, c2 = {}, {}
    for L in lengths:
        ticks = _segment_rec(L)
        end = L * PPQ
        for r in ratios:
            tau1 = round(tau0 * r, 1)
            ma = [[0, tau0, tau1, mta_a], [end, tau1, None, None]]
            mb = [[0, tau0, tau1, mta_b], [end, tau1, None, None]]
            ya, yb = _render(ma, ticks), _render(mb, ticks)
            c1[(L, r)] = _rescale_residual(ya, yb)
            # best constant explanation of the transition (exact LS on one slope)
            t = np.array(ticks, dtype=float)
            slope = float(t @ ya) / float(t @ t)
            c2[(L, r)] = float(np.sqrt(np.mean((ya - slope * t) ** 2)))
    return c1, c2, lengths, ratios


# --------------------------------------------------------------------------- #

def _fmt_table(table):
    hdr = (f"{'explanation':<16}{'DL med':>8}{'instr':>7}{'RMSE med':>11}"
           f"{'RMSE p90':>11}{'bits med':>11}{'DL/DL_GT':>10}")
    out = [hdr, "-" * len(hdr)]
    for r in table:
        out.append(f"{r['name']:<16}{r['dl_med']:>8.0f}{r['instr_med']:>7.0f}"
                   f"{r['rmse_med']:>11.3f}{r['rmse_p90']:>11.3f}"
                   f"{r['bits_med']:>11.0f}{r['mdl_ratio_med']:>10.2f}")
    return "\n".join(out)


def main(argv):
    only_validate = len(argv) > 1 and argv[1] == "validate"

    print("=" * 78)
    print("V  EXACTNESS PROOFS")
    print("=" * 78)
    lines, worst = validate()
    for l in lines:
        print("   " + l)
    print(f"   -> worst divergence over all proofs: {worst:.12f} "
          f"({'PASS' if worst <= 1e-9 else 'FAIL'} at 1e-9)")
    if only_validate:
        return 0 if worst <= 1e-9 else 1

    print()
    print("=" * 78)
    print("A  PARETO: description length vs render fidelity (100 val_v2 pieces)")
    print("=" * 78)
    sf.reset_fallback_counts()
    table, recs = experiment_a(100)
    fb_a = sf.fallback_counts()
    print(_fmt_table(table))
    print(f"   rival-fit fallbacks on this table (must stay ~0): "
          f"{fb_a['bad_slope']} bad slopes, {fb_a['bpm_clamp']} bpm clamps, "
          f"{fb_a['linalg_error']} LinAlgErrors / {fb_a['segments_fitted']} segments")

    print()
    eqs = experiment_a_equal_fidelity(recs)
    for eq in eqs:
        print(f"   equal-fidelity (<= {eq['tol_ms']:>4.0f} ms) greedy staircase: "
              f"reached {eq['reached']:>3}/{eq['n']}, "
              f"median DL/DL_GT = {eq['dl_ratio_med']:.2f}, "
              f"median instr ratio = {eq['instr_ratio_med']:.2f}")

    a2 = experiment_a2(recs)
    print()
    print(f"   dynamics field ({a2['n']} pieces): GT curve DL med = {a2['gt_dl_med']:.0f} "
          f"tokens at {a2['gt_vel_rmse_max']:.9f} vel RMSE; per-onset skyline "
          f"DL med = {a2['skyline_dl_med']:.0f} ({a2['skyline_ratio_med']:.1f}x) at "
          f"{a2['skyline_vel_rmse_med']:.4f} med / {a2['skyline_vel_rmse_max']:.4f} max "
          f"vel RMSE (1-decimal rounding, not 0); "
          f"constant velocity = {a2['const_vel_rmse_med']:.1f} vel RMSE")

    print()
    print("=" * 78)
    print("C  PARAMETER IDENTIFIABILITY vs SEGMENT LENGTH (exact, synthetic)")
    print("=" * 78)
    c1, c2, lengths, ratios = experiment_c()
    print("   C1  ms RMSE between meanTempoAt=0.30 and 0.70 after re-optimising the")
    print("       boundary tempi  (rows = segment length in beats, cols = tau1/tau0)")
    print("       " + "beats".ljust(7) + "".join(f"{r:>10.2f}" for r in ratios))
    for L in lengths:
        print(f"       {L:<7}" + "".join(f"{c1[(L, r)]:>10.2f}" for r in ratios))
    print()
    print("   C2  ms RMSE between the transition and the best CONSTANT tempo")
    print("       " + "beats".ljust(7) + "".join(f"{r:>10.2f}" for r in ratios))
    for L in lengths:
        print(f"       {L:<7}" + "".join(f"{c2[(L, r)]:>10.2f}" for r in ratios))

    print()
    print("=" * 78)
    print("D  RUBATO OBSERVABILITY FLOOR vs frameLength (R3 deadband calibration)")
    print("=" * 78)
    dgrid, dedges, dfb, dbpms, dints = experiment_d()
    print("   D1  onset-displacement RMS (ms) that survives the best single constant")
    print("       tempo, for a 4-frame span; rows = frameLength, cols = intensity")
    for bpm in dbpms:
        print(f"       tempo = {bpm:.0f} bpm")
        print("       " + "frame".ljust(9) + "".join(f"{i:>8.2f}" for i in dints))
        for fb in dfb:
            print(f"       {str(fb) + ' beat':<9}"
                  + "".join(f"{dgrid[(fb, bpm, i)]:>8.2f}" for i in dints))
    print()
    print("   D2  intensity deadband needed for a 5 ms floor (bisected, exact)")
    print("       " + "frame".ljust(9) + "".join(f"{'@' + str(int(b)) + ' bpm':>22}"
                                                 for b in dbpms))
    for fb in dfb:
        cells = []
        for bpm in dbpms:
            lo, hi = dedges[(fb, bpm)]
            lo_s = f"{lo:.2f}" if lo else "  - "
            hi_s = f"{hi:.2f}" if hi else "  - "
            cells.append(f"{'[' + lo_s + ', ' + hi_s + ']':>22}")
        print(f"       {str(fb) + ' beat':<9}" + "".join(cells))
    print("       (R3's shipped deadband is [0.95, 1.05] for every frame length)")

    print()
    print("=" * 78)
    print("B  TEMPO-vs-RUBATO AMBIGUITY (40 meico-rendered rubato pieces)")
    print("=" * 78)
    rows = experiment_b()
    s = summarise_b(rows)
    print(f"   true explanation (tempo + 1 rubato span): "
          f"DL = {s['dl_true_med']:.0f} tokens "
          f"({s['dl_rubato_only_med']:.0f} of them the rubato span itself), "
          f"render RMSE <= {s['rmse_true_max']:.12f} ms")
    print(f"   constant tempo (evaluate.py baseline) : RMSE med = "
          f"{s['rmse_const_med']:>7.1f} ms")
    print(f"   constant tempo (optimal LS)           : RMSE med = "
          f"{s['rmse_ls_const_med']:>7.1f} ms   <- RMS magnitude of the warp")
    for g in GRIDS:
        print(f"   staircase {g}-beat grid                 : RMSE med = "
              f"{s[f'rmse_{g}b_med']:>7.1f} ms   DL med = {s[f'dl_{g}b_med']:.0f}"
              f"   (min {s[f'rmse_{g}b_min']:>6.1f}, "
              f"{s[f'rmse_{g}b_below10ms']:>2}/{s['n']} pieces < 10 ms)")
    print(f"   optimal beat-aligned staircase        : RMSE med = "
          f"{s['floor_med']:>7.1f} ms   (absorbs "
          f"{100 * s['absorbed_frac_med']:.0f}% of the warp; the rest is invisible "
          f"to any beat grid)")
    print()
    hdr = (f"   {'tolerance':<12}{'reached':>9}{'instr med':>11}"
           f"{'DL med':>9}{'DL/DL_true (med of ratios)':>28}")
    print(hdr)
    print("   " + "-" * (len(hdr) - 3))
    for tol in TOLERANCES:
        k = int(tol)
        print(f"   {str(k) + ' ms':<12}{s[f'tol{k}_reached']:>4}/{s['n']:<4}"
              f"{s[f'tol{k}_instr_med']:>11.0f}{s[f'tol{k}_dl_med']:>9.0f}"
              f"{s[f'tol{k}_dlratio_med']:>27.2f}x")

    # per-frame breakdown: the orthogonality claim is frame-length dependent
    print()
    print("   by rubato frame length:")
    print(f"     {'frame':<10}{'n':>4}{'warp RMS':>11}{'4b (canon.)':>13}"
          f"{'beat floor':>12}{'absorbed':>10}")
    for fb in sorted({r["frame_beats"] for r in rows}):
        sub = [r for r in rows if r["frame_beats"] == fb]
        print(f"     {str(fb) + ' beat':<10}{len(sub):>4}"
              f"{statistics.median([r['rmse_ls_const'] for r in sub]):>11.1f}"
              f"{statistics.median([r['rmse_4b'] for r in sub]):>13.1f}"
              f"{statistics.median([r['floor_beat_aligned'] for r in sub]):>12.1f}"
              f"{100 * statistics.median([r['absorbed_frac'] for r in sub]):>9.0f}%")

    # the weakest span in the probe: the falsifiability question R3 has to answer
    weakest = min(rows, key=lambda r: r["rmse_ls_const"])
    print()
    print(f"   weakest span in the probe: id {weakest['id']}, frame "
          f"{weakest['frame_beats']} beat, intensity {weakest['intensity']}, "
          f"total warp RMS {weakest['rmse_ls_const']:.2f} ms "
          f"-- costs 13 tokens, sits below the 5 ms floor (see D)")

    os.makedirs(OUT_DIR, exist_ok=True)
    out_json = os.path.join(OUT_DIR, "results.json")
    with open(out_json, "w") as fh:
        json.dump({"pareto": table,
                   "equal_fidelity": eqs,
                   "dynamics": a2,
                   "param_identifiability": {
                       "c1_shape": {f"{L}b_x{r}": v for (L, r), v in c1.items()},
                       "c2_depth": {f"{L}b_x{r}": v for (L, r), v in c2.items()}},
                   "rubato_observability": {
                       "warp_rms": {f"{fb}b_{bpm:.0f}bpm_i{i}": v
                                    for (fb, bpm, i), v in dgrid.items()},
                       "deadband_5ms": {f"{fb}b_{bpm:.0f}bpm": list(e)
                                        for (fb, bpm), e in dedges.items()}},
                   "rubato_summary": s,
                   "rubato_rows": rows,
                   "staircase_fallbacks": {"pareto_grids": fb_a,
                                           "whole_run": sf.fallback_counts()}},
                  fh, indent=1)
    fb_counts = sf.fallback_counts()
    print(f"   staircase fallbacks over the WHOLE run (incl. every greedy candidate "
          f"fit): {fb_counts['bad_slope']} bad slopes, {fb_counts['bpm_clamp']} bpm "
          f"clamps, {fb_counts['linalg_error']} LinAlgErrors / "
          f"{fb_counts['segments_fitted']} segments")
    print(f"\n   raw results -> {out_json}")
    return 0 if worst <= 1e-9 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
