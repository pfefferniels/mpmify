"""The competitor explanation: a piecewise-CONSTANT tempo staircase.

Why this exists
---------------
The canonical normal form claims that *smooth* tempo (constant + power-function
transitions, segments >= 4 beats) is the natural description of inter-boundary
timing.  The obvious rival hypothesis is that timing is just "many constant tempi":
a staircase on a fixed beat grid.  A staircase can approximate ANY monotone
tick->ms map to arbitrary accuracy, so it is the right adversary for an
identifiability / MDL argument: canonical MPM has to win on *description length at
equal fidelity*, not on fidelity alone.

Exact fitting
-------------
Under meico's semantics a constant tempo instruction contributes

    ms(t) = 15000 * (t - d0) / (bpm * beatLength * ppq)  =  s * (t - d0),
    s = 15000 / (bpm * 0.25 * 720) = 83.3333.../bpm      [ms per tick]

so for a staircase with boundaries b_0=0 < b_1 < ... < b_{m-1} the rendered onset
of a note at tick t is EXACTLY LINEAR in the slope vector s:

    ms(t) = sum_j s_j * L_j(t),   L_j(t) = clip(t - b_j, 0, b_{j+1} - b_j)

(last column unbounded above).  Fitting the staircase to the observed (tick, ms)
pairs is therefore an ordinary linear least-squares problem, solved globally --
which is strictly stronger than fitting each segment independently from its local
IOIs, because the global solution also absorbs the offset drift that independent
per-segment slopes accumulate.  We give the rival the strongest possible fit.

`design_matrix` is validated against `tempo_math.TempoTimeline` to <= 1e-9 ms.

After fitting, bpm values are rounded to the canonical precision (1 decimal) and
adjacent equal constants are merged, exactly as the canonical sampler does, so the
DL comparison is apples-to-apples.
"""

import math
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "python"))

from tempo_math import PPQ, BEAT_LENGTH, TempoTimeline   # noqa: E402

MS_PER_TICK_AT_1BPM = 15000.0 / (BEAT_LENGTH * PPQ)      # = 83.3333...

# The fitter has two numerical fallbacks (a rank-deficient / non-positive slope is
# replaced by the global mean slope, and bpm is clamped to [10, 1000]).  Both weaken
# the rival explanation, so they must never fire silently: they are counted here and
# reported by identifiability.py.  Measured on the 100-piece x 4-grid A workload:
# 6 bad slopes and 3 bpm clamps out of 6036 segments, 0 LinAlgErrors.
_FALLBACKS = {"segments_fitted": 0, "bad_slope": 0, "bpm_clamp": 0,
              "linalg_error": 0}


def fallback_counts():
    """Copy of the fallback counters accumulated since import / last reset."""
    return dict(_FALLBACKS)


def reset_fallback_counts():
    for k in _FALLBACKS:
        _FALLBACKS[k] = 0


def bpm_to_slope(bpm):
    return MS_PER_TICK_AT_1BPM / bpm


def slope_to_bpm(s):
    return MS_PER_TICK_AT_1BPM / s


# --------------------------------------------------------------------------- #

def grid_boundaries(total_ticks, grid_beats, ppq=PPQ):
    """Uniform boundaries at multiples of `grid_beats` (may be fractional)."""
    step = grid_beats * ppq
    n = max(1, int(math.ceil(total_ticks / step)))
    return [int(round(j * step)) for j in range(n)]


def design_matrix(ticks, boundaries):
    """L[i, j] = ticks of note i that fall inside segment j."""
    t = np.asarray(ticks, dtype=float)[:, None]
    b = np.asarray(boundaries, dtype=float)[None, :]
    width = np.full_like(b, np.inf)
    width[0, :-1] = b[0, 1:] - b[0, :-1]
    return np.clip(t - b, 0.0, width)


def _solve(L, y, ridge_rel=1e-8):
    """Ridge-stabilised LS toward the global mean slope; the ridge only bites on
    rank-deficient columns (segments containing no note information)."""
    n_seg = L.shape[1]
    denom = float(L[:, 0].sum() + L[:, 1:].sum()) if n_seg else 0.0
    s0 = (y.sum() / denom) if denom > 0 else bpm_to_slope(100.0)
    lam = ridge_rel * max(float(np.mean(np.sum(L * L, axis=0))), 1e-12)
    A = L.T @ L + lam * np.eye(n_seg)
    rhs = L.T @ y + lam * s0 * np.ones(n_seg)
    try:
        s = np.linalg.solve(A, rhs)
    except np.linalg.LinAlgError:
        _FALLBACKS["linalg_error"] += 1
        s = np.linalg.lstsq(L, y, rcond=None)[0]
    bad = ~np.isfinite(s) | (s <= 1e-9)
    _FALLBACKS["segments_fitted"] += int(s.size)
    _FALLBACKS["bad_slope"] += int(np.count_nonzero(bad))
    s[bad] = s0
    return s


def _to_map(boundaries, slopes, bpm_decimals=1, merge=True):
    instrs = []
    for b, s in zip(boundaries, slopes):
        raw = slope_to_bpm(s)
        bpm = min(max(raw, 10.0), 1000.0)
        if bpm != raw:
            _FALLBACKS["bpm_clamp"] += 1
        bpm = round(bpm, bpm_decimals)
        if merge and instrs and instrs[-1][1] == bpm:
            continue
        instrs.append([int(b), bpm, None, None])
    return instrs


def fit_staircase(rec, grid_beats, ppq=PPQ, bpm_decimals=1, merge=True,
                  boundaries=None):
    """Best piecewise-constant tempo map for `rec` on the given grid."""
    notes = rec["notes"]
    ticks = [n[0] for n in notes]
    y = np.array([n[3] for n in notes], dtype=float)
    total = max(n[0] + n[1] for n in notes)
    if boundaries is None:
        boundaries = grid_boundaries(total, grid_beats, ppq)
    L = design_matrix(ticks, boundaries)
    s = _solve(L, y)
    return _to_map(boundaries, s, bpm_decimals, merge)


def greedy_path(rec, target_rmse=0.0, max_instr=64, ppq=PPQ,
                candidate_grid_ticks=180, bpm_decimals=1):
    """Greedy boundary insertion; returns the WHOLE path so every tolerance can be
    priced from one run.

    Candidates are grid points (default: sixteenth notes) carrying note information
    -- deliberately allowing SUB-BEAT boundaries, which is what a staircase needs in
    order to imitate rubato.  At each step the boundary giving the largest SSE
    reduction is added and ALL slopes are refit (global LS, see module docstring).

    Returns a list of dicts: {"n_instr", "rmse", "map"} after each insertion, in
    increasing model size.  Stops when `target_rmse` is met or `max_instr` reached.
    """
    notes = rec["notes"]
    ticks = [n[0] for n in notes]
    y = np.array([n[3] for n in notes], dtype=float)
    total = max(n[0] + n[1] for n in notes)

    cands = sorted({int(round(t / candidate_grid_ticks) * candidate_grid_ticks)
                    for t in ticks if t > 0})
    cands = [c for c in cands if 0 < c < total]

    def fit(bnds):
        L = design_matrix(ticks, bnds)
        s = _solve(L, y)
        return float(np.sum((L @ s - y) ** 2)), _to_map(bnds, s, bpm_decimals, True)

    chosen = [0]
    path = []
    _, tmap = fit(chosen)
    rmse = _rendered_rmse(tmap, rec)
    path.append({"n_instr": len(tmap), "rmse": rmse, "map": tmap})
    if rmse <= target_rmse:
        return path

    remaining = list(cands)
    while remaining and len(chosen) < max_instr:
        best = None
        for c in remaining:
            bnds = sorted(chosen + [c])
            sse, _ = fit(bnds)
            if best is None or sse < best[0]:
                best = (sse, c, bnds)
        _, c, chosen = best
        remaining.remove(c)
        _, tmap = fit(chosen)
        rmse = _rendered_rmse(tmap, rec)
        path.append({"n_instr": len(tmap), "rmse": rmse, "map": tmap})
        if rmse <= target_rmse:
            break
    return path


def first_reaching(path, tol):
    """Cheapest point on a greedy path whose rendered RMSE is <= tol (or None)."""
    for p in path:
        if p["rmse"] <= tol:
            return p
    return None


def fit_staircase_adaptive(rec, target_rmse, max_instr=64, **kw):
    """Convenience wrapper: (map, path) for the cheapest staircase at `target_rmse`."""
    path = greedy_path(rec, target_rmse, max_instr=max_instr, **kw)
    hit = first_reaching(path, target_rmse)
    return (hit or path[-1])["map"], path


def _rendered_rmse(tempo_map, rec):
    tl = TempoTimeline(tempo_map)
    se = 0.0
    for n in rec["notes"]:
        e = tl.ms_at(n[0]) - n[3]
        se += e * e
    return math.sqrt(se / len(rec["notes"]))


# --------------------------------------------------------------------------- #
# validation: the linear model must reproduce meico's constant-tempo rendering
# --------------------------------------------------------------------------- #

def validate_design_matrix(seed=0, n_cases=200):
    """max | L @ s  -  TempoTimeline.ms_at |  over random staircases.  Must be ~0."""
    rng = np.random.default_rng(seed)
    worst = 0.0
    for _ in range(n_cases):
        n_seg = int(rng.integers(1, 9))
        widths = rng.integers(1, 9, size=n_seg) * PPQ
        bounds = [0] + list(np.cumsum(widths)[:-1].astype(int))
        bpms = np.round(np.exp(rng.uniform(math.log(40), math.log(200), n_seg)), 1)
        tmap = [[int(b), float(v), None, None] for b, v in zip(bounds, bpms)]
        total = int(np.sum(widths))
        ticks = sorted(rng.integers(0, total, size=40).tolist())
        L = design_matrix(ticks, bounds)
        s = np.array([bpm_to_slope(v) for v in bpms])
        pred = L @ s
        tl = TempoTimeline(tmap)
        ref = np.array([tl.ms_at(t) for t in ticks])
        worst = max(worst, float(np.max(np.abs(pred - ref))))
    return worst


if __name__ == "__main__":
    w = validate_design_matrix()
    print(f"staircase design-matrix vs meico constant-tempo rendering: "
          f"max |diff| = {w:.12f} ms over 200 random staircases x 40 notes")
    sys.exit(0 if w <= 1e-9 else 1)
