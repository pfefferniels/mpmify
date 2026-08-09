"""Fit a canonical movementMap chain to a REAL sustain-pedal stream (Vienna 4x22).

Why this exists
---------------
v4 adds the movementMap (pedalling).  Before a sampler can be written, canonical form
has to answer three questions that only real data can settle:

  1. what *granularity* does a movement chain need (boundary grid, minimum segment
     length) to explain a human sustain-pedal trace?
  2. what does that cost in description length (DSL tokens)?
  3. which part of the trace is even *inside* the movementMap's hypothesis class,
     i.e. what is the pedal representation ceiling?

The Vienna 4x22 corpus carries the continuous Bosendorfer SE pedal sensor as
`sustain_cc` = [[ms, value], ...] in `ml/data/vienna_infer.jsonl` (312,380 sustain
events corpus-wide, 97.9 % of values strictly between 1 and 126 -- genuine
half-pedalling, not on/off).  This module fits meico's own movement-Bezier chain to
those traces.

Forward model (exact)
---------------------
A movementMap is a chain of `<movement>` instructions.  Instruction j at tick b_j has
`position` p_j and `transition.to` p_{j+1}, and its end date is b_{j+1} (the next
instruction's date).  Between them meico evaluates the same cubic-Bezier S-curve as
DynamicsData (`MovementData.getPositionAt`):

    pos(d) = p_j + f_j(d) * (p_{j+1} - p_j),
    f_j(d) = (3 - 2t) t^2   with t = getTForDate(d)  [binary search, 1-tick tolerance]

f_j depends only on (b_j, b_{j+1}, curvature_j, protraction_j).  So **for fixed shape
parameters the whole chain is LINEAR in the position vector p** -- fitting it to an
observed trace is an ordinary bounded linear least-squares problem over p, exactly as
`staircase_fit.py` does for tempo slopes.  Shapes are then chosen per segment by grid
search (each segment's shape only affects its own samples), alternating with the
linear solve.

`bezier_fraction` is a vectorised port of meico's scalar math and is proven
**bit-identical** to it two ways (see `validate()`):
  V1  vs `python/dynamics_math.dynamics_at` (the project's audited scalar port), and
  V2  vs `meico.mpm.elements.maps.data.MovementData.getPositionAt` itself
      (`--java-proof`: emits MovementProbe.java, compiles it against the fork, and
      compares 4000 random cases).  Measured: 4000/4000 bit-identical, max|diff| = 0.
  V3  `movement_segment` vs `MovementData.getMovementSegment(0.1)` -- the actual
      renderer sampler, including the duplicated first/last points and the *127.
      Swept over 200 random parameter tuples, of which 10 are PLATEAUS
      (`transition.to` absent), because meico appends the trailing
      `[endDate, transitionTo]` point only `if (this.transitionTo != null)` and a
      plateau therefore emits three coincident points at `startDate`, not four.
      An earlier revision of this file exercised a single tuple and got the plateau
      case wrong; M5/M6 make plateaus the dominant canonical instruction, so the
      sweep is the proof that matters.
  V5  `fit_chain` vs an independent bounded solver on the same design matrix --
      the fit is a genuine *bounded* least squares (`scipy.optimize.lsq_linear`),
      not an unconstrained solve followed by a clip.  The bound is active on real
      traces (typically 10-20 % of positions sit at 0 or 1), and clipping an
      unconstrained solution is measurably worse, so an "oracle/ceiling" claim needs
      the constrained optimum.

Rendering-side facts this module relies on (read from the fork at 1d662105):
  * `MovementMap.renderMovementToMap` skips the LAST instruction
    (`movementIndex < this.size() - 1`), so a chain must be closed by a terminator
    instruction that emits nothing but supplies the final endDate.
  * `Msm.parsePositionMap` emits `Math.round(value)` where value = position*127, on
    CC 64 for controller="sustain" and CC 67 for "soft".  So the observable is
    `round(127 * pos)` and the natural error unit is CC units.
  * `MovementMap.getPreviousPosition(index)` loops `for (j = index-1; j > 0; --j)`,
    so instruction #1 can NEVER inherit from instruction #0 (it silently gets 0.0).
    Position inheritance is therefore unsafe at index 1 in this fork -- see findings.

Usage
-----
    nice -n 15 python3 pedal_fit.py                 # 20 performances, full report
    nice -n 15 python3 pedal_fit.py validate        # exactness proofs only
    nice -n 15 python3 pedal_fit.py --java-proof    # + the meico cross-check
    nice -n 15 python3 pedal_fit.py --n 4 --quick   # smoke run

Writes `analysis/out/pedal_fit.json`; prints the tables used by `findings_v4.md`.
Nothing here mutates project state.
"""

import argparse
import heapq
import json
import math
import os
import statistics
import subprocess
import sys
import tempfile
import time

import numpy as np
import scipy.sparse as sp
from scipy.optimize import lsq_linear
from scipy.signal import find_peaks
from scipy.sparse.linalg import lsqr

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "python"))

from dynamics_math import inner_control_points, dynamics_at   # noqa: E402
import mdl                                                     # noqa: E402

PPQ = 720
CC_MAX = 127.0
DATA = os.path.join(_HERE, "..", "data", "vienna_infer.jsonl")
OUT = os.path.join(_HERE, "out")

MEICO = "/Users/nielspfeffer/Projects/meico"
MEICO_CP = f"{MEICO}/out/production/meico:{MEICO}/externals/*"

# meico's own defaults (MovementData fields) -- an omitted attribute renders as these
DEFAULT_CURVATURE = 0.4
DEFAULT_PROTRACTION = 0.0

CURV_GRID = (0.0, 0.1, 0.2, 0.4, 0.6, 0.8)
PROT_GRID = (-0.6, -0.3, 0.0, 0.3, 0.6)

# CANONICAL.md M3: movement boundaries live on a 1/4-beat grid and every segment is
# >= 180 ticks.  Both the uniform and the adaptive families below are held to it, so
# every chain this module prices is a *conforming* chain.  (An earlier revision used a
# 1/8-beat candidate grid for the adaptive family, which put up to 56 % of its segments
# at 90 ticks -- below the renderer's own inversion floor of 127/L cc.)
M3_GRID_TICKS = 0.25 * PPQ          # 180
M3_MIN_SEGMENT_TICKS = 180.0

# Explicit definition of a "pedal cycle" for the signal statistics of A1, so the
# plateau/release levels that feed the v4 sampler are reproducible: a local extremum
# of the collapsed CC trace with topographic prominence >= PEAK_PROMINENCE_CC
# (scipy.signal.find_peaks).  16 cc is the depth deadband recommended in findings_v4
# C1 -- a shallower excursion is invisible against the fit floor of A2.
PEAK_PROMINENCE_CC = 16.0


# --------------------------------------------------------------------------- #
# exact forward model
# --------------------------------------------------------------------------- #

def bezier_fraction(dates, start, end, curvature=DEFAULT_CURVATURE,
                    protraction=DEFAULT_PROTRACTION):
    """f(d) in [0,1] such that pos(d) = p0 + f(d)*(p1-p0), vectorised over `dates`.

    Reproduces `MovementData.getTForDate` bit-for-bit: same initial t = 0.5, same
    halving step, same `|diffX| >= 1.0` stopping rule, per element (converged
    elements are frozen, which is what the scalar loop does by returning).
    """
    x1, x2 = inner_control_points(curvature, protraction)
    s = float(end) - float(start)
    d = np.asarray(dates, dtype=float) - float(start)
    u = 3.0 * x1 - 3.0 * x2 + 1.0
    v = -6.0 * x1 + 3.0 * x2
    w = 3.0 * x1
    t = np.full(d.shape, 0.5)
    diff = (((u * t + v) * t + w) * t * s) - d
    tt = 0.25
    active = np.abs(diff) >= 1.0
    it = 0
    while active.any() and it < 400:
        t = np.where(active, np.where(diff > 0.0, t - tt, t + tt), t)
        diff = np.where(active, (((u * t + v) * t + w) * t * s) - d, diff)
        tt *= 0.5
        active = active & (np.abs(diff) >= 1.0)
        it += 1
    f = (3.0 - 2.0 * t) * t * t
    dates = np.asarray(dates, dtype=float)
    f = np.where(dates <= float(start), 0.0, f)     # getPositionAt: date <= startDate
    f = np.where(dates >= float(end), 1.0, f)       # getPositionAt: date >= endDate
    return f


def movement_segment(start, end, p0, p1, curvature=DEFAULT_CURVATURE,
                     protraction=DEFAULT_PROTRACTION, max_step=0.1):
    """Exact port of `MovementData.getMovementSegment(maxStepSize)` (returns [date, cc]).

    Includes meico's duplicated first point and the appended exact end point, and the
    final `*127`.  This is what the renderer actually emits as CC events.

    `p1 is None` means a PLATEAU (`transition.to` absent, `isConstantMovement()`).
    meico then takes three separate shortcuts, all reproduced here:
      * `getDatePosition(t)` returns `{startDate, position}` for *every* t, so both
        seed points coincide and the subdivision loop never fires;
      * the leading `{startDate, position}` is still inserted at index 0;
      * the trailing `{endDate, transitionTo}` is appended only
        `if (this.transitionTo != null)` -- i.e. NOT here.
    The emitted segment is therefore three coincident points at `startDate`, and the
    plateau is carried to the next instruction by the zero-order hold, not by an event
    at `endDate`.
    """
    if p1 is None:
        v = float(p0) * 127.0
        return [[float(start), v], [float(start), v], [float(start), v]]

    x1, x2 = inner_control_points(curvature, protraction)
    x1_3, x2_3 = 3.0 * x1, 3.0 * x2
    u = x1_3 - x2_3 + 1.0
    v = -6.0 * x1 + x2_3
    length = float(end) - float(start)

    def dp(t):
        return [((((u * t) + v) * t + x1_3) * t * length) + float(start),
                ((3.0 - 2.0 * t) * t * t) * (p1 - p0) + p0]

    ts = [0.0, 1.0]
    series = [dp(0.0), dp(1.0)]
    i = 0
    while i < len(ts) - 1:
        while abs(series[i + 1][1] - series[i][1]) > max_step:
            t = (ts[i] + ts[i + 1]) * 0.5
            ts.insert(i + 1, t)
            series.insert(i + 1, dp(t))
        i += 1
    series.insert(0, [float(start), p0])
    series.append([float(end), p1])
    return [[e[0], e[1] * 127.0] for e in series]


# --------------------------------------------------------------------------- #
# data preparation
# --------------------------------------------------------------------------- #

def collapse_stream(cc_events):
    """last-wins at duplicate timestamps; collapses the degenerate opening burst.

    The corpus opens every performance with a burst of up to ~315 CC events all at
    ms = 0 (a ramp at zero elapsed time).  No movement curve can express infinite
    slope, and MPM/MIDI state semantics are last-wins, so the burst collapses to its
    FINAL value = the pedal state the piece starts in.  Returns (ms, cc, n_dropped,
    n_burst) with ms strictly increasing.
    """
    ms = np.array([e[0] for e in cc_events], dtype=float)
    cc = np.array([e[1] for e in cc_events], dtype=float)
    order = np.argsort(ms, kind="stable")          # stable => corpus order preserved
    ms, cc = ms[order], cc[order]
    keep = np.ones(len(ms), dtype=bool)
    keep[:-1] = ms[1:] != ms[:-1]                  # keep the LAST of each run
    n_burst = int(np.count_nonzero(ms == ms[0])) if len(ms) else 0
    return ms[keep], cc[keep], int(np.count_nonzero(~keep)), n_burst


class ScoreTimeMap:
    """Empirical tick <-> ms map of one performance, from its matched note onsets.

    movementMap dates are score TICKS; the rendered CC dates are those ticks pushed
    through the tempoMap.  To fit a chain to a real trace we therefore need the
    performance's own tick->ms map.  We take, per distinct score tick, the MEAN of the
    performed onsets at that tick (chord spread is asynchrony, not tempo), enforce
    strict monotonicity, and interpolate linearly; outside the note range we
    extrapolate with the edge slope (pedal outlives the last note).

    `to_ticks` and `to_ms` are exact inverses everywhere, including outside the note
    range: both extrapolate with the edge slope.  (`np.interp` alone constant-clamps
    outside its knots, which would make the forward map disagree with the inverse for
    the pedal events that outlive the last note -- a few tens of events per
    performance, all in the tail.)
    """

    def __init__(self, notes):
        by_tick = {}
        for n in notes:
            by_tick.setdefault(int(n[0]), []).append(float(n[3]))
        ticks = np.array(sorted(by_tick), dtype=float)
        ms = np.array([float(np.mean(by_tick[int(t)])) for t in ticks], dtype=float)
        ms = np.maximum.accumulate(ms)
        for i in range(1, len(ms)):
            if ms[i] <= ms[i - 1]:
                ms[i] = ms[i - 1] + 1e-6
        self.ticks, self.ms = ticks, ms

    def to_ticks(self, ms):
        ms = np.asarray(ms, dtype=float)
        out = np.interp(ms, self.ms, self.ticks)
        s0 = (self.ticks[1] - self.ticks[0]) / (self.ms[1] - self.ms[0])
        s1 = (self.ticks[-1] - self.ticks[-2]) / (self.ms[-1] - self.ms[-2])
        out = np.where(ms < self.ms[0], self.ticks[0] + (ms - self.ms[0]) * s0, out)
        out = np.where(ms > self.ms[-1], self.ticks[-1] + (ms - self.ms[-1]) * s1, out)
        return out

    def to_ms(self, ticks):
        """Exact inverse of `to_ticks`, edge-slope extrapolation included."""
        ticks = np.asarray(ticks, dtype=float)
        out = np.interp(ticks, self.ticks, self.ms)
        s0 = (self.ms[1] - self.ms[0]) / (self.ticks[1] - self.ticks[0])
        s1 = (self.ms[-1] - self.ms[-2]) / (self.ticks[-1] - self.ticks[-2])
        out = np.where(ticks < self.ticks[0],
                       self.ms[0] + (ticks - self.ticks[0]) * s0, out)
        out = np.where(ticks > self.ticks[-1],
                       self.ms[-1] + (ticks - self.ticks[-1]) * s1, out)
        return out

    def n_outside(self, ticks):
        """How many of `ticks` fall outside the matched-note range (audit trail)."""
        t = np.asarray(ticks, dtype=float)
        return int(np.count_nonzero((t < self.ticks[0]) | (t > self.ticks[-1])))


# --------------------------------------------------------------------------- #
# fitting
# --------------------------------------------------------------------------- #

def _design(ticks, bounds, shapes):
    n_seg = len(bounds) - 1
    seg = np.clip(np.searchsorted(bounds, ticks, side="right") - 1, 0, n_seg - 1)
    f = np.zeros(len(ticks))
    for j in range(n_seg):
        k = seg == j
        if k.any():
            f[k] = bezier_fraction(ticks[k], bounds[j], bounds[j + 1], *shapes[j])
    rows = np.repeat(np.arange(len(ticks)), 2)
    cols = np.column_stack([seg, seg + 1]).ravel()
    vals = np.column_stack([1.0 - f, f]).ravel()
    A = sp.csr_matrix((vals, (rows, cols)), shape=(len(ticks), n_seg + 1))
    return A, seg, f


def _bounded_solve(A, y):
    """min ||A p - y||_2 subject to 0 <= p <= 1.  A genuine constrained solve.

    The position vector is physically confined to [0, 1] (`Msm.parsePositionMap`
    emits `round(127*p)`), and the constraint is ACTIVE on real traces -- typically
    10-20 % of the fitted positions sit exactly at a bound, because a real pedal
    spends real time fully up or fully down.  An unconstrained `lsqr` followed by
    `np.clip` is therefore not the optimum of the constrained problem: clipping
    changes the residual of every observation in the clipped segment and the
    neighbouring positions are never re-optimised against it.  Measured on the
    corpus, the clip-after-lsqr shortcut is 0.4-0.8 cc worse at the 1/4-beat grid,
    which is material when the number is being quoted as a representation ceiling.
    """
    r = lsq_linear(A, y, bounds=(0.0, 1.0), method="trf",
                   lsq_solver="lsmr", lsmr_tol="auto", tol=1e-12,
                   max_iter=200, verbose=0)
    return np.clip(r.x, 0.0, 1.0)      # numerical hygiene only; r.x is feasible


def fit_chain(ticks, cc, bounds, free_shape=False,
              shape0=(DEFAULT_CURVATURE, DEFAULT_PROTRACTION), n_iter=2):
    """Bounded LS for the position vector (+ optional per-segment shape search).

    Returns dict(bounds, positions, shapes, rmse, pred, n_at_bound).
    """
    bounds = np.asarray(bounds, dtype=float)
    n_seg = len(bounds) - 1
    y = cc / CC_MAX
    shapes = [tuple(shape0)] * n_seg
    p = None
    for _ in range(n_iter if free_shape else 1):
        A, seg, _ = _design(ticks, bounds, shapes)
        p = _bounded_solve(A, y)
        if not free_shape:
            break
        for j in range(n_seg):
            k = seg == j
            if not k.any() or abs(p[j + 1] - p[j]) < 1e-4:
                continue
            best = None
            for c in CURV_GRID:
                for r in PROT_GRID:
                    fj = bezier_fraction(ticks[k], bounds[j], bounds[j + 1], c, r)
                    sse = float(np.sum((p[j] + fj * (p[j + 1] - p[j]) - y[k]) ** 2))
                    if best is None or sse < best[0]:
                        best = (sse, c, r)
            shapes[j] = (best[1], best[2])
    A, seg, _ = _design(ticks, bounds, shapes)
    p = _bounded_solve(A, y)
    pred = (A @ p) * CC_MAX
    seg_len = np.diff(bounds)
    return {"bounds": bounds, "positions": p, "shapes": shapes,
            "rmse": float(np.sqrt(np.mean((pred - cc) ** 2))), "pred": pred,
            "n_at_bound": int(np.count_nonzero((p <= 1e-9) | (p >= 1.0 - 1e-9))),
            "min_seg_ticks": float(seg_len.min()) if len(seg_len) else float("nan")}


def uniform_bounds(hi_ticks, grid_beats):
    step = grid_beats * PPQ
    n = max(1, int(math.ceil(hi_ticks / step)))
    return np.arange(n + 1) * step


def rdp_knots(x, y, n_target):
    """Douglas-Peucker knot selection: the classic max-deviation polyline reduction.

    For a pedal trace (long plateaus + fast ramps) this places knots at the corners,
    which uniform grids cannot.  Returns indices into x/y, sorted.
    """
    n = len(x)
    if n < 3:
        return list(range(n))

    def worst(lo, hi):
        if hi - lo < 2:
            return 0.0, None
        xs, ys = x[lo:hi + 1], y[lo:hi + 1]
        span = x[hi] - x[lo]
        t = (xs - x[lo]) / span if span > 0 else np.zeros_like(xs)
        dev = np.abs(ys - (y[lo] + t * (y[hi] - y[lo])))
        i = int(np.argmax(dev))
        return float(dev[i]), lo + i

    knots = [0, n - 1]
    h = []
    d, i = worst(0, n - 1)
    if i is not None:
        heapq.heappush(h, (-d, 0, n - 1, i))
    while h and len(knots) < n_target:
        _, lo, hi, i = heapq.heappop(h)
        knots.append(i)
        for a, b in ((lo, i), (i, hi)):
            d2, j = worst(a, b)
            if j is not None:
                heapq.heappush(h, (-d2, a, b, j))
    return sorted(set(knots))


def snap_bounds(cand_ticks, raw_ticks, hi, min_gap):
    """Snap knot ticks onto the candidate grid, enforce the minimum segment length."""
    pts = sorted({0.0, float(cand_ticks[-1])}
                 | {float(cand_ticks[int(np.argmin(np.abs(cand_ticks - t)))])
                    for t in raw_ticks})
    out = [pts[0]]
    for x in pts[1:]:
        if x - out[-1] >= min_gap - 1e-9:
            out.append(x)
    if out[-1] < hi:
        out.append(float(cand_ticks[-1]))
    return np.array(sorted(set(out)))


# --------------------------------------------------------------------------- #
# description length of a movement chain
# --------------------------------------------------------------------------- #

def dl_movement_chain(bounds, positions, shapes, ppq=PPQ, mode="delta_cc",
                      grid_ticks=None, default_shape=(DEFAULT_CURVATURE,
                                                      DEFAULT_PROTRACTION),
                      inherit_position=False):
    """Tokens for one movement chain under the v4 grammar (CANONICAL.md v4 §9/§11).

        chain := ( 'G' date 'Z' pos 'R' to [ 'Q' curv 'P' prot ] )*    (M6 in force)
                 'G' date 'C'                                          (terminator)

    **M6 (position on every instruction) is the CANONICAL form** while the two
    `MovementMap.getPreviousPosition` defects are unfixed, so `inherit_position=False`
    is the canonical setting and the default here.  `inherit_position=True` prices the
    post-fix chain (`Z` only on the first instruction), i.e. what M6 relaxes to.

    The **terminator carries no `Z`**: its `position` never renders
    (`renderMovementToMap` iterates `movementIndex < size()-1`), and the compiler
    writes it into the XML deterministically as the previous instruction's
    `transition.to` -- which it MUST, because `getMovementDataOf` is still called for
    the last index and an omitted `position` there would re-enter the defective
    `getPreviousPosition`.  Being compiler-generated it costs zero description length,
    exactly like `beatLength` or `loop` (CANONICAL.md §5).

    `mode` prices three encodings of the numeric literals:
      "beats_norm" : date in beats (fractional), position in 0..1 with 2 decimals
      "beats_cc"   : date in beats (fractional), position as an integer 0..127
      "delta_cc"   : date as an INTEGER DELTA in units of the movement grid
                     (M3: 1/4 beat = 180 ticks), position as an integer 0..127
                     <- canonical
    Shape tokens are charged only when (curvature, protraction) != the meico default,
    since an omitted attribute renders as the default.
    """
    nt = mdl.n_num_tokens
    n_seg = len(bounds) - 1
    grid = grid_ticks or ppq

    def date_tok(j):
        if mode == "delta_cc":
            if j == 0:
                return nt(0)
            return nt(int(round((bounds[j] - bounds[j - 1]) / grid)))
        b = bounds[j] / ppq
        b = round(b, 3)
        return nt(int(b) if b == int(b) else b)

    def pos_tok(p):
        if mode == "beats_norm":
            return nt(round(float(p), 2))
        return nt(int(round(float(p) * CC_MAX)))

    n = 0
    for j in range(n_seg):
        n += 1 + date_tok(j)                                   # 'G' <date>
        if j == 0 or not inherit_position:
            n += 1 + pos_tok(positions[j])                     # 'Z' <position>
        n += 1 + pos_tok(positions[j + 1])                     # 'R' <to>
        c, r = shapes[j]
        if (round(c, 2), round(r, 2)) != (round(default_shape[0], 2),
                                          round(default_shape[1], 2)):
            n += 1 + nt(round(float(c), 2))                    # 'Q' <curvature>
            n += 1 + nt(round(float(r), 2))                    # 'P' <protraction>
    n += 1 + date_tok(n_seg) + 1                               # 'G' <date> 'C'
    return n


# --------------------------------------------------------------------------- #
# renderer-faithful evaluation
# --------------------------------------------------------------------------- #

def render_chain_cc(bounds, positions, shapes, tmap, query_ms, max_step=0.1):
    """Emit the chain exactly as meico would (sampled + rounded + zero-order hold)
    and read it back at `query_ms`.  Returns (predicted integer CC per query point,
    n_events, n_events_outside_note_range)."""
    ev_ticks, ev_vals = [], []
    for j in range(len(bounds) - 1):
        # M5: a segment whose CC endpoints coincide is a PLATEAU (no transition.to)
        p1 = (None if round(positions[j] * CC_MAX) == round(positions[j + 1] * CC_MAX)
              else positions[j + 1])
        for d, val in movement_segment(bounds[j], bounds[j + 1], positions[j],
                                       p1, shapes[j][0], shapes[j][1],
                                       max_step):
            ev_ticks.append(d)
            ev_vals.append(val)
    ev_ticks = np.asarray(ev_ticks, dtype=float)
    ev_vals = np.round(np.asarray(ev_vals, dtype=float))
    n_out = tmap.n_outside(ev_ticks)
    # tick -> ms must use the SAME map as ms -> tick, extrapolation included; np.interp
    # alone constant-clamps past the last matched note, where the pedal still lives.
    ev_ms = tmap.to_ms(ev_ticks)
    ev_ms = np.round(ev_ms)                       # Msm writes a long millisecond date
    order = np.argsort(ev_ms, kind="stable")
    ev_ms, ev_vals = ev_ms[order], ev_vals[order]
    keep = np.ones(len(ev_ms), dtype=bool)
    keep[:-1] = ev_ms[1:] != ev_ms[:-1]           # last-wins, as in the MIDI stream
    ev_ms, ev_vals = ev_ms[keep], ev_vals[keep]
    idx = np.clip(np.searchsorted(ev_ms, np.asarray(query_ms), side="right") - 1,
                  0, len(ev_ms) - 1)
    return ev_vals[idx], len(ev_ms), n_out


# --------------------------------------------------------------------------- #
# exactness proofs
# --------------------------------------------------------------------------- #

JAVA_PROBE = r'''
import meico.mpm.elements.maps.data.MovementData;
import java.util.ArrayList;
import java.util.Random;

public class MovementProbe {
    public static void main(String[] args) throws Exception {
        int n = args.length > 0 ? Integer.parseInt(args[0]) : 4000;
        long seed = args.length > 1 ? Long.parseLong(args[1]) : 12345L;
        Random rnd = new Random(seed);
        for (int i = 0; i < n; ++i) {
            double start = Math.floor(rnd.nextDouble() * 20000.0);
            double end = start + 90.0 + Math.floor(rnd.nextDouble() * 6000.0);
            double pos = rnd.nextDouble();
            double to = rnd.nextDouble();
            double curv = rnd.nextDouble() * 0.9;
            double prot = (rnd.nextDouble() * 1.4) - 0.7;
            double date = start + rnd.nextDouble() * (end - start);
            MovementData md = new MovementData();
            md.startDate = start; md.endDate = end; md.position = pos;
            md.transitionTo = to; md.curvature = curv; md.protraction = prot;
            System.out.println("P " + start + " " + end + " " + pos + " " + to + " "
                    + curv + " " + prot + " " + date + " " + md.getPositionAt(date));
        }
        // V3: sweep getMovementSegment over 200 random parameter tuples, of which
        // every 20th is a PLATEAU (transition.to absent) -- the case an earlier
        // revision of pedal_fit.py got wrong.
        Random rs = new Random(seed + 1L);
        for (int i = 0; i < 200; ++i) {
            double start = Math.floor(rs.nextDouble() * 20000.0);
            double end = start + 180.0 + Math.floor(rs.nextDouble() * 6000.0);
            double pos = rs.nextDouble();
            boolean plateau = (i % 20) == 0;
            double to = rs.nextDouble();
            double curv = rs.nextDouble() * 0.9;
            double prot = (rs.nextDouble() * 1.4) - 0.7;
            MovementData m2 = new MovementData();
            m2.startDate = start; m2.endDate = end; m2.position = pos;
            m2.transitionTo = plateau ? null : to;
            m2.curvature = curv; m2.protraction = prot;
            StringBuilder sb = new StringBuilder();
            sb.append("S ").append(i).append(" ").append(start).append(" ")
              .append(end).append(" ").append(pos).append(" ")
              .append(plateau ? "null" : Double.toString(to)).append(" ")
              .append(curv).append(" ").append(prot);
            for (double[] e : m2.getMovementSegment(0.1))
                sb.append(" ").append(e[0]).append(" ").append(e[1]);
            System.out.println(sb.toString());
        }
    }
}
'''


def validate(java_proof=False, n_cases=4000, verbose=True):
    """V1 (always) and V2/V3 (with --java-proof).  All must be exactly 0."""
    res = {}
    rng = np.random.default_rng(7)
    worst = 0.0
    exact = 0
    for _ in range(n_cases):
        start = float(rng.integers(0, 20000))
        end = start + float(rng.integers(90, 6000))
        p0, p1 = float(rng.uniform(0, 1)), float(rng.uniform(0, 1))
        c, r = float(rng.uniform(0, 0.9)), float(rng.uniform(-0.7, 0.7))
        d = float(rng.uniform(start, end))
        mine = p0 + bezier_fraction([d], start, end, c, r)[0] * (p1 - p0)
        ref = dynamics_at(d, [start, p0, p1, c, r], end)
        worst = max(worst, abs(mine - ref))
        exact += (mine == ref)
    res["V1_vs_dynamics_math"] = {"cases": n_cases, "bit_identical": exact,
                                  "max_abs_diff": worst}
    if verbose:
        print(f"V1 vectorised Bezier vs python/dynamics_math (audited scalar port) : "
              f"{exact}/{n_cases} bit-identical, max |diff| = {worst:.17g}")

    if java_proof:
        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, "MovementProbe.java")
            with open(src, "w") as fh:
                fh.write(JAVA_PROBE)
            subprocess.run(["javac", "-cp", MEICO_CP, "-d", td, src], check=True)
            out = subprocess.run(["java", "-cp", f"{td}:{MEICO_CP}", "MovementProbe",
                                  "4000", "12345"],
                                 check=True, capture_output=True, text=True).stdout
        wj, ej, nj = 0.0, 0, 0
        n_seg_cases = n_seg_ok = n_plateau = n_plateau_ok = 0
        n_points = 0
        ws = 0.0
        for line in out.splitlines():
            f = line.split()
            if f[0] == "P":
                st, en, p0, p1, c, r, d, val = map(float, f[1:])
                mine = p0 + bezier_fraction([d], st, en, c, r)[0] * (p1 - p0)
                wj = max(wj, abs(mine - val))
                ej += (mine == val)
                nj += 1
            elif f[0] == "S":
                start, end, pos = float(f[2]), float(f[3]), float(f[4])
                to = None if f[5] == "null" else float(f[5])
                curv, prot = float(f[6]), float(f[7])
                flat = [float(v) for v in f[8:]]
                ref = [[flat[i], flat[i + 1]] for i in range(0, len(flat), 2)]
                mine = movement_segment(start, end, pos, to, curv, prot, 0.1)
                n_seg_cases += 1
                n_plateau += (to is None)
                if len(mine) == len(ref):
                    d_ = max(max(abs(a[0] - b[0]), abs(a[1] - b[1]))
                             for a, b in zip(mine, ref))
                    ws = max(ws, d_)
                    n_points += len(ref)
                    if d_ == 0.0:
                        n_seg_ok += 1
                        n_plateau_ok += (to is None)
                else:
                    ws = float("inf")
        res["V2_vs_meico_MovementData"] = {"cases": nj, "bit_identical": ej,
                                           "max_abs_diff": wj}
        res["V3_vs_getMovementSegment"] = {"cases": n_seg_cases,
                                           "bit_identical": n_seg_ok,
                                           "plateau_cases": n_plateau,
                                           "plateau_bit_identical": n_plateau_ok,
                                           "points_compared": n_points,
                                           "max_abs_diff": ws}
        if verbose:
            print(f"V2 vectorised Bezier vs meico MovementData.getPositionAt        : "
                  f"{ej}/{nj} bit-identical, max |diff| = {wj:.17g}")
            print(f"V3 movement_segment vs MovementData.getMovementSegment(0.1)     : "
                  f"{n_seg_ok}/{n_seg_cases} cases bit-identical "
                  f"({n_plateau_ok}/{n_plateau} plateaus, {n_points} points), "
                  f"max |diff| = {ws:.17g}")

    # V4 -- the renderer's OWN value resolution.  getTForDate stops as soon as the
    # x-error is < 1 TICK, so on a segment of L ticks the returned position carries a
    # systematic error of up to 127/L CC units.  With curvature = protraction = 0 the
    # exact curve is the straight line, which makes the error directly measurable.
    # This is what fixes the canonical minimum segment length (M3).
    res["V4_getTForDate_resolution_cc"] = {}
    if verbose:
        print("V4 renderer resolution floor (curvature=0, exact answer is linear):")
    for L in (45, 90, 180, 254, 360, 720):
        d = np.linspace(0.0, float(L), 2001)
        err = float(np.max(np.abs(bezier_fraction(d, 0.0, float(L), 0.0, 0.0)
                                  - d / L)) * CC_MAX)
        res["V4_getTForDate_resolution_cc"][L] = err
        if verbose:
            print(f"     segment {L:>5} ticks -> max |curve - line| = {err:6.3f} cc "
                  f"(= 127/L = {127.0/L:6.3f})")

    # V5 -- the position solve is a genuine BOUNDED least squares, not an
    # unconstrained solve followed by a clip.  On random problems with an active
    # constraint the constrained optimum must be no worse, and is usually strictly
    # better; the shipped fitter must attain it.
    rng = np.random.default_rng(11)
    n_probs, n_better, n_worse = 0, 0, 0
    gains = []
    for _ in range(200):
        n_seg = int(rng.integers(3, 25))
        L = 180.0
        bounds = np.arange(n_seg + 1) * L
        ticks = np.sort(rng.uniform(0, bounds[-1], size=n_seg * 12))
        shapes = [(DEFAULT_CURVATURE, DEFAULT_PROTRACTION)] * n_seg
        A, _, _ = _design(ticks, bounds, shapes)
        # a target that pushes the solution against the bounds
        y = np.clip(rng.normal(0.5, 0.9, size=len(ticks)), -0.4, 1.4)
        p_b = _bounded_solve(A, y)
        p_c = np.clip(lsqr(A, y, atol=1e-10, btol=1e-10, iter_lim=4000)[0], 0.0, 1.0)
        sse_b = float(np.sum((A @ p_b - y) ** 2))
        sse_c = float(np.sum((A @ p_c - y) ** 2))
        n_probs += 1
        if sse_b < sse_c - 1e-12:
            n_better += 1
        if sse_b > sse_c + 1e-9:
            n_worse += 1
        gains.append((math.sqrt(sse_c / len(ticks)) - math.sqrt(sse_b / len(ticks)))
                     * CC_MAX)
    res["V5_bounded_vs_clipped"] = {"problems": n_probs, "bounded_better": n_better,
                                    "bounded_worse": n_worse,
                                    "median_gain_cc": statistics.median(gains),
                                    "p90_gain_cc": float(np.percentile(gains, 90)),
                                    "max_gain_cc": max(gains)}
    if verbose:
        print(f"V5 bounded LS (lsq_linear) vs clip-after-lsqr, active bounds     : "
              f"bounded better in {n_better}/{n_probs}, NEVER worse "
              f"({n_worse}/{n_probs}); gain p50 {statistics.median(gains):.3f} / "
              f"p90 {np.percentile(gains, 90):.3f} / max {max(gains):.3f} cc")

    # V6 -- third witness for movement_segment: the concurrently-landed scalar port
    # `python/movement_math.py`.  Includes plateaus, which is where the two ports
    # previously disagreed (this file appended the trailing point unconditionally).
    try:
        import movement_math as mm                                  # noqa: E402
    except Exception as exc:                                        # pragma: no cover
        res["V6_vs_movement_math"] = {"skipped": repr(exc)}
        if verbose:
            print(f"V6 movement_segment vs python/movement_math                     : "
                  f"SKIPPED ({exc})")
    else:
        n_t = n_t_ok = n_p = n_p_ok = 0
        wm = 0.0
        rng = np.random.default_rng(23)
        for i in range(500):
            start = float(rng.integers(0, 20000))
            end = start + float(rng.integers(180, 6000))
            p0 = float(rng.uniform(0, 1))
            plateau = (i % 2 == 0)
            p1 = None if plateau else float(rng.uniform(0, 1))
            c = float(rng.uniform(0, 0.9))
            r = float(rng.uniform(-0.7, 0.7))
            mine = movement_segment(start, end, p0, p1, c, r, 0.1)
            ref = mm.MovementData(start, end, p0, p1, c, r).get_movement_segment(0.1)
            ok = len(mine) == len(ref)
            if ok:
                d_ = max(max(abs(a[0] - b[0]), abs(a[1] - b[1]))
                         for a, b in zip(mine, ref))
                wm = max(wm, d_)
                ok = d_ == 0.0
            else:
                wm = float("inf")
            if plateau:
                n_p += 1
                n_p_ok += ok
            else:
                n_t += 1
                n_t_ok += ok
        res["V6_vs_movement_math"] = {"transition_cases": n_t, "transition_ok": n_t_ok,
                                      "plateau_cases": n_p, "plateau_ok": n_p_ok,
                                      "max_abs_diff": wm}
        if verbose:
            print(f"V6 movement_segment vs python/movement_math (scalar port)       : "
                  f"{n_t_ok}/{n_t} transitions, {n_p_ok}/{n_p} plateaus "
                  f"bit-identical, max |diff| = {wm:.17g}")
    return res


# --------------------------------------------------------------------------- #
# per-performance experiment
# --------------------------------------------------------------------------- #

def dwell_quantile(hist, p):
    """p-th percentile of a dwell histogram over CC values 0..127."""
    h = np.asarray(hist, dtype=float)
    c = np.cumsum(h)
    if c[-1] <= 0:
        return float("nan")
    return float(np.searchsorted(c, p / 100.0 * c[-1]))


def signal_stats(ms, cc, W, dur_s):
    """Characterisation of one collapsed sustain trace.

    Every quantity is computed for ONE performance, so a report can aggregate it
    however it likes.  Two families, deliberately kept apart because they answer
    different questions and differ by several points:

      * `frac_*` / `q_*`      -- DWELL-WEIGHTED (time shares and time-weighted
                                 quantiles) *for this performance*.  Pooling these
                                 across performances weights by recording length;
                                 taking their median does not.  Both are reported.
      * `plateau_*` / `release_*` -- levels of the pedal cycle, from an EXPLICIT
                                 extremum definition: local maxima / minima of the
                                 collapsed trace with topographic prominence
                                 >= PEAK_PROMINENCE_CC (`scipy.signal.find_peaks`).
                                 This is what makes the v4 sampler's plateau/release
                                 ranges reproducible.
    """
    # dwell histogram over the 128 CC values, in ms.  Everything time-weighted is
    # derived from it, so per-performance and pooled aggregations use the SAME
    # definition and the pooled figures are recoverable from the JSON.
    hist = np.bincount(np.clip(cc, 0, 127).astype(int),
                       weights=W * dur_s * 1000.0, minlength=128)
    qs = [dwell_quantile(hist, p) for p in (5, 25, 50, 75, 95)]

    peaks, _ = find_peaks(cc, prominence=PEAK_PROMINENCE_CC)
    troughs, _ = find_peaks(-cc, prominence=PEAK_PROMINENCE_CC)
    plateau = cc[peaks]
    release = cc[troughs]

    def pct(a, p):
        return float(np.percentile(a, p)) if len(a) else float("nan")

    return {
        "dwell_hist_ms": [float(v) for v in hist],
        "frac_time_strictly_between": float(hist[1:127].sum() / hist.sum()),
        "frac_time_zero": float(hist[0] / hist.sum()),
        "frac_time_full": float(hist[127] / hist.sum()),
        "frac_events_strictly_between": float(np.mean((cc > 0) & (cc < 127))),
        "q_timeweighted": qs,
        "n_plateaus": int(len(plateau)), "n_releases": int(len(release)),
        "plateau_p10": pct(plateau, 10), "plateau_med": pct(plateau, 50),
        "plateau_p90": pct(plateau, 90),
        "release_p10": pct(release, 10), "release_med": pct(release, 50),
        "release_p90": pct(release, 90),
        "cycles_per_second": len(peaks) / dur_s if dur_s > 0 else float("nan"),
        "plateau_levels": [float(v) for v in plateau],
        "release_levels": [float(v) for v in release],
        "dwell_total_ms": float(dur_s * 1000.0),
    }


def analyse(rec, quick=False):
    ms, cc, n_dropped, n_burst = collapse_stream(rec["sustain_cc"])
    tmap = ScoreTimeMap(rec["notes"])
    ticks = tmap.to_ticks(ms)
    hi = float(ticks.max())
    dur_s = float(ms[-1] - ms[0]) / 1000.0
    beats = hi / PPQ
    beat_ms = 1000.0 * dur_s / beats if beats else float("nan")

    dwell = np.diff(np.append(ms, ms[-1] + float(np.median(np.diff(ms)))))
    W = np.maximum(dwell, 0.0)
    W = W / W.sum()

    row = {
        "id": rec["id"], "piece": rec["piece"], "pianist": rec["pianist"],
        "n_events": int(len(cc)), "n_dropped_dupes": n_dropped,
        "n_opening_burst": n_burst, "opening_state_cc": float(cc[0]),
        "duration_s": dur_s, "beats": beats,
        "beat_ms": beat_ms, "cc_std": float(cc.std()),
        "cc_std_timeweighted": float(math.sqrt(np.sum(W * (cc - np.sum(W * cc)) ** 2))),
        "frac_strictly_between": float(np.mean((cc > 0) & (cc < 127))),
        "n_threshold_crossings": int(np.count_nonzero(np.diff((cc >= 64).astype(int)))),
        "n_obs_outside_note_range": tmap.n_outside(ticks),
        "signal": signal_stats(ms, cc, W, dur_s),
        "fits": [],
    }
    # constant baseline (single position, chain of 2 instructions)
    const = float(np.mean(cc))
    row["rmse_constant"] = float(np.sqrt(np.mean((cc - const) ** 2)))

    # audit for V5 on REAL data: what the clip-after-lsqr shortcut would have cost.
    row["bounded_vs_clipped"] = []
    for gb in ((1,) if quick else (1, 0.25)):
        b = uniform_bounds(hi, gb)
        shapes = [(DEFAULT_CURVATURE, DEFAULT_PROTRACTION)] * (len(b) - 1)
        A, _, _ = _design(ticks, b, shapes)
        y = cc / CC_MAX
        pb = _bounded_solve(A, y)
        pc = np.clip(lsqr(A, y, atol=1e-10, btol=1e-10, iter_lim=4000)[0], 0.0, 1.0)
        row["bounded_vs_clipped"].append({
            "grid_beats": gb, "n_pos": int(len(pb)),
            "n_at_bound": int(np.count_nonzero((pb <= 1e-9) | (pb >= 1 - 1e-9))),
            "rmse_bounded": float(np.sqrt(np.mean(((A @ pb) * CC_MAX - cc) ** 2))),
            "rmse_clipped": float(np.sqrt(np.mean(((A @ pc) * CC_MAX - cc) ** 2)))})

    grids = (4, 2, 1, 0.5) if quick else (4, 2, 1, 0.5, 0.25)
    for gb in grids:
        b = uniform_bounds(hi, gb)
        for free, tag in (((False, "default"),) if quick
                          else ((False, "default"), (False, "linear"), (True, "free"))):
            shape0 = (0.0, 0.0) if tag == "linear" else (DEFAULT_CURVATURE,
                                                         DEFAULT_PROTRACTION)
            fit = fit_chain(ticks, cc, b, free_shape=free, shape0=shape0)
            row["fits"].append(_score(fit, cc, W, ticks, tmap, ms, dur_s,
                                      f"uniform-{gb}", tag, gb * PPQ))

    if not quick:
        # M3: candidate knots on the 1/4-beat grid, minimum segment 180 ticks.  The
        # adaptive family is priced in the SAME units it is snapped to, so the
        # "delta date" tokens it is charged are the tokens a canonical chain spends.
        step = M3_GRID_TICKS
        cand = np.arange(0, hi + step, step)
        for budget in (25, 50, 100, 200, 400):
            ki = rdp_knots(ticks, cc / CC_MAX, budget)
            b = snap_bounds(cand, ticks[ki], hi, M3_MIN_SEGMENT_TICKS)
            variants = ((False, "default"), (True, "free")) if budget == 200 \
                else ((False, "default"),)
            for free, tag in variants:
                fit = fit_chain(ticks, cc, b, free_shape=free)
                row["fits"].append(_score(fit, cc, W, ticks, tmap, ms, dur_s,
                                          f"rdp-{budget}", tag, step))
    return row


def _score(fit, cc, W, ticks, tmap, ms, dur_s, family, shape_tag, grid_ticks):
    pred = fit["pred"]
    n_seg = len(fit["bounds"]) - 1
    # DL under M6 (position written on every instruction) -- the CANONICAL cost while
    # the two getPreviousPosition defects are unfixed.
    dls = {m: dl_movement_chain(fit["bounds"], fit["positions"], fit["shapes"],
                                mode=m, grid_ticks=grid_ticks)
           for m in ("beats_norm", "beats_cc", "delta_cc")}
    # what M6 relaxes to once the fork is fixed: `Z` only on the first instruction
    dl_inherit = dl_movement_chain(fit["bounds"], fit["positions"], fit["shapes"],
                                   mode="delta_cc", grid_ticks=grid_ticks,
                                   inherit_position=True)
    rend, n_ev, n_out = render_chain_cc(fit["bounds"], fit["positions"],
                                        fit["shapes"], tmap, ms, max_step=0.1)
    rend2, n_ev2, _ = render_chain_cc(fit["bounds"], fit["positions"], fit["shapes"],
                                      tmap, ms, max_step=0.02)
    n_shaped = sum(1 for c, r in fit["shapes"]
                   if (round(c, 2), round(r, 2)) != (DEFAULT_CURVATURE,
                                                     DEFAULT_PROTRACTION))
    return {
        "family": family, "shape": shape_tag, "n_seg": n_seg,
        "n_nondefault_shapes": n_shaped,
        "grid_ticks": float(grid_ticks),
        "min_seg_ticks": fit["min_seg_ticks"],
        "m3_conforming": bool(fit["min_seg_ticks"] >= M3_MIN_SEGMENT_TICKS - 1e-9
                              and grid_ticks >= M3_GRID_TICKS - 1e-9),
        "n_positions_at_bound": fit["n_at_bound"],
        "rmse": fit["rmse"],
        "rmse_tw": float(math.sqrt(np.sum(W * (pred - cc) ** 2))),
        "rmse_rendered_step0.1": float(np.sqrt(np.mean((rend - cc) ** 2))),
        "rmse_rendered_step0.02": float(np.sqrt(np.mean((rend2 - cc) ** 2))),
        "n_cc_events_step0.1": int(n_ev), "n_cc_events_step0.02": int(n_ev2),
        "n_events_outside_note_range": int(n_out),
        "binary_agree_step0.1": float(np.sum(W * ((rend >= 64) == (cc >= 64)))),
        "dl_tokens": dls, "dl_tokens_inherited_position": dl_inherit,
        "tokens_per_seg": dls["delta_cc"] / max(n_seg, 1),
        "tokens_per_second": dls["delta_cc"] / dur_s,
    }


# --------------------------------------------------------------------------- #
# report
# --------------------------------------------------------------------------- #

def select(records, n):
    """n performances, spread evenly over pieces and pianists (deterministic)."""
    by_piece = {}
    for r in records:
        by_piece.setdefault(r["piece"], []).append(r)
    pieces = sorted(by_piece)
    per = max(1, n // len(pieces))
    out = []
    for p in pieces:
        rs = sorted(by_piece[p], key=lambda r: r["id"])
        step = max(1, len(rs) // per)
        out.extend(rs[::step][:per])
    return out[:n]


def med(rows, key):
    v = [r[key] for r in rows if r[key] == r[key]]
    return statistics.median(v) if v else float("nan")


def report(rows):
    """Print every table findings_v4 §A quotes, from already-computed rows."""
    print("\n" + "=" * 78)
    print("A. Canonical movement chain vs real half-pedalling (medians over "
          f"{len(rows)} performances)")
    print("=" * 78)
    print("DL = canonical tokens under M6 (explicit `position`); every family below "
          "conforms to M3\n(1/4-beat grid, segments >= 180 ticks).  binAgr = "
          "time-weighted CC-64 threshold agreement.")
    print(f"{'family':<14}{'shape':<9}{'n_seg':>7}{'seg ms':>8}{'minTk':>7}{'RMSE':>8}"
          f"{'RMSE_tw':>9}{'rendered':>10}{'DL':>8}{'tok/seg':>9}{'tok/s':>8}"
          f"{'binAgr':>8}{'M3':>4}")
    fams = [f["family"] + "|" + f["shape"] for f in rows[0]["fits"]]
    for key in fams:
        pairs = [(r, f) for r in rows for f in r["fits"]
                 if f["family"] + "|" + f["shape"] == key]
        sub = [f for _, f in pairs]
        segms = statistics.median([r["duration_s"] * 1000 / f["n_seg"]
                                   for r, f in pairs])
        dl = statistics.median([f["dl_tokens"]["delta_cc"] for f in sub])
        fam, shape = key.split("|")
        ok = "yes" if all(f["m3_conforming"] for f in sub) else "NO"
        print(f"{fam:<14}{shape:<9}{med(sub,'n_seg'):>7.0f}{segms:>8.0f}"
              f"{med(sub,'min_seg_ticks'):>7.0f}"
              f"{med(sub,'rmse'):>8.2f}{med(sub,'rmse_tw'):>9.2f}"
              f"{med(sub,'rmse_rendered_step0.1'):>10.2f}{dl:>8.0f}"
              f"{med(sub,'tokens_per_seg'):>9.1f}{med(sub,'tokens_per_second'):>8.1f}"
              f"{med(sub,'binary_agree_step0.1'):>8.2f}{ok:>4}")
    print(f"{'constant':<14}{'-':<9}{1:>7}{'-':>8}{'-':>7}"
          f"{statistics.median([r['rmse_constant'] for r in rows]):>8.2f}")

    print("\n" + "=" * 78)
    print("A1. What the signal is -- per-performance stats, aggregated two ways")
    print("=" * 78)
    sig = [r["signal"] for r in rows]
    pool = np.sum(np.array([s["dwell_hist_ms"] for s in sig], dtype=float), axis=0)
    print("Two aggregations of the same per-performance quantities.  They differ by "
          "2-3 points\nbecause pooling weights each performance by its recording "
          "length; quote which one.")
    print(f"{'quantity':<44}{'median over perfs':>20}{'POOLED (dwell)':>18}")
    for key, label, pv in (
            ("frac_time_strictly_between", "time share with 0 < cc < 127",
             pool[1:127].sum() / pool.sum()),
            ("frac_time_zero", "time share fully up (cc = 0)", pool[0] / pool.sum()),
            ("frac_time_full", "time share fully down (cc = 127)",
             pool[127] / pool.sum())):
        print(f"{label:<44}{100*statistics.median([s[key] for s in sig]):>19.1f}%"
              f"{100*pv:>17.1f}%")
    for i, qn in enumerate(("p05", "p25", "p50", "p75", "p95")):
        v = [s["q_timeweighted"][i] for s in sig]
        print(f"{'time-weighted quantile ' + qn:<44}"
              f"{statistics.median(v):>20.0f}"
              f"{dwell_quantile(pool, (5,25,50,75,95)[i]):>18.0f}")
    print(f"{'signal sd (cc)':<44}"
          f"{statistics.median([r['cc_std'] for r in rows]):>20.1f}"
          f"{statistics.median([r['cc_std_timeweighted'] for r in rows]):>18.1f}"
          "   (right col = time-weighted)")
    print(f"{'CC events per performance':<44}"
          f"{statistics.median([r['n_events'] for r in rows]):>20.0f}")
    print(f"\npedal cycle levels (local extrema, prominence >= "
          f"{PEAK_PROMINENCE_CC:.0f} cc, scipy.signal.find_peaks)")
    print(f"{'quantity':<44}{'p10':>10}{'median':>10}{'p90':>10}{'per perf':>10}")
    for pre, label in (("plateau", "plateau level (local maximum)"),
                       ("release", "release level (local minimum)")):
        allv = np.concatenate([np.asarray(s[pre + "_levels"]) for s in sig
                               if s[pre + "_levels"]])
        print(f"{label + '  [median of per-perf]':<44}"
              f"{statistics.median([s[pre+'_p10'] for s in sig]):>10.0f}"
              f"{statistics.median([s[pre+'_med'] for s in sig]):>10.0f}"
              f"{statistics.median([s[pre+'_p90'] for s in sig]):>10.0f}"
              f"{statistics.median([s['n_' + pre + 's'] for s in sig]):>10.0f}")
        print(f"{label + '  [pooled over all cycles]':<44}"
              f"{np.percentile(allv, 10):>10.0f}{np.percentile(allv, 50):>10.0f}"
              f"{np.percentile(allv, 90):>10.0f}{len(allv):>10.0f}")
    cps = [s["cycles_per_second"] for s in sig]
    print(f"{'pedal cycles per second':<44}"
          f"{np.percentile(cps,10):>10.2f}{statistics.median(cps):>10.2f}"
          f"{np.percentile(cps,90):>10.2f}")

    print("\n" + "=" * 78)
    print("A2. Fidelity vs segment duration in MILLISECONDS (all M3-conforming "
          "families pooled)")
    print("=" * 78)
    pts = [(r["duration_s"] * 1000.0 / f["n_seg"], f["rmse"], f["rmse_tw"])
           for r in rows for f in r["fits"] if f["shape"] == "default"]
    edges = [0, 180, 360, 720, 1440, 2880, 5760, 1e9]
    print(f"{'mean segment duration':<26}{'n fits':>8}{'RMSE (cc)':>12}"
          f"{'RMSE_tw (cc)':>14}")
    for lo, hi in zip(edges[:-1], edges[1:]):
        b = [p for p in pts if lo <= p[0] < hi]
        if not b:
            continue
        lbl = f"{lo:.0f} - {hi:.0f} ms" if hi < 1e8 else f">= {lo:.0f} ms"
        print(f"{lbl:<26}{len(b):>8}{statistics.median([p[1] for p in b]):>12.1f}"
              f"{statistics.median([p[2] for p in b]):>14.1f}")
    print(f"  for scale: the signal's own sd is "
          f"{statistics.median([r['cc_std'] for r in rows]):.1f} cc "
          f"(time-weighted {statistics.median([r['cc_std_timeweighted'] for r in rows]):.1f})")
    print("  M3 caps the finest canonical segment at 180 ticks, so the reachable "
          "bucket depends\n  on tempo: 1/4 beat is 102 ms on Schubert D783/15 and "
          "451 ms on Chopin op10/3.")

    print("\n" + "=" * 78)
    print("B. Per-piece breakdown (uniform-1 beat, default shape / rdp-200)")
    print("=" * 78)
    print(f"{'piece':<22}{'beat ms':>9}{'std':>7}{'u1 RMSE':>9}{'u0.25':>8}"
          f"{'rdp200':>9}{'rdp200 DL':>11}{'tok/s':>8}")
    for piece in sorted({r["piece"] for r in rows}):
        sub = [r for r in rows if r["piece"] == piece]

        def pick(fam, shape="default", k="rmse"):
            return statistics.median([f[k] for r in sub for f in r["fits"]
                                      if f["family"] == fam and f["shape"] == shape])
        try:
            print(f"{piece:<22}{statistics.median([r['beat_ms'] for r in sub]):>9.0f}"
                  f"{statistics.median([r['cc_std'] for r in sub]):>7.1f}"
                  f"{pick('uniform-1'):>9.2f}{pick('uniform-0.25'):>8.2f}"
                  f"{pick('rdp-200'):>9.2f}"
                  f"{statistics.median([f['dl_tokens']['delta_cc'] for r in sub for f in r['fits'] if f['family']=='rdp-200']):>11.0f}"
                  f"{pick('rdp-200', k='tokens_per_second'):>8.1f}")
        except statistics.StatisticsError:
            pass

    print("\n" + "=" * 78)
    print("C. Encoding cost of one movement chain (medians over performances)")
    print("=" * 78)
    for fam in ("uniform-0.25", "rdp-200"):
        for shape in ("default", "free"):
            sub = [f for r in rows for f in r["fits"]
                   if f["family"] == fam and f["shape"] == shape]
            if not sub:
                continue
            nseg = statistics.median([f["n_seg"] for f in sub])
            print(f"  {fam}, shape = {shape}  ({nseg:.0f} segments, "
                  f"{statistics.median([f['n_nondefault_shapes'] for f in sub]):.0f} "
                  f"non-default shapes)")
            for m, label in (("beats_norm",
                              "fractional-beat dates, 0..1 positions (2 dec)"),
                             ("beats_cc",
                              "fractional-beat dates, integer CC positions"),
                             ("delta_cc",
                              "1/4-beat delta dates, integer CC  <- CANONICAL (M6)")):
                t = statistics.median([f["dl_tokens"][m] for f in sub])
                print(f"    {label:<52} {t:>6.0f} tokens ({t/nseg:.1f}/seg)")
            t = statistics.median([f["dl_tokens_inherited_position"] for f in sub])
            print(f"    {'... same, with position inheritance (post-fork-fix)':<52} "
                  f"{t:>6.0f} tokens ({t/nseg:.1f}/seg)")
            # medians of per-performance RATIOS (this document's convention)
            for a, b, lbl in (("beats_norm", "delta_cc", "beats_norm / delta_cc"),
                              ("beats_cc", "delta_cc", "beats_cc   / delta_cc")):
                rr = statistics.median([f["dl_tokens"][a] / f["dl_tokens"][b]
                                        for f in sub])
                print(f"    {'ratio ' + lbl:<52} {rr:>6.2f}x")
            rr = statistics.median([f["dl_tokens"]["delta_cc"]
                                    / f["dl_tokens_inherited_position"] for f in sub])
            print(f"    {'ratio M6-explicit / inherited':<52} {rr:>6.2f}x  "
                  f"(inheritance saves {100*(1-1/rr):.0f} %)")

    print("\n" + "=" * 78)
    print("D. Audits")
    print("=" * 78)
    ok = sum(1 for r in rows if r["n_dropped_dupes"] == r["n_opening_burst"] - 1)
    print(f"  burst-collapse: n_dropped_duplicates == n_burst - 1 in "
          f"{ok}/{len(rows)} performances")
    print(f"    opening burst sizes : "
          f"{sorted(r['n_opening_burst'] for r in rows)}")
    st = sorted(int(r["opening_state_cc"]) for r in rows)
    print(f"    collapsed opening state (cc): {st}")
    print(f"    -> median {statistics.median(st):.0f}, "
          f"> 0 in {sum(1 for v in st if v > 0)}/{len(st)}")
    m3bad = [(f["family"], f["shape"]) for r in rows for f in r["fits"]
             if not f["m3_conforming"]]
    print(f"  M3 conformance (1/4-beat grid, segments >= 180 ticks): "
          f"{len(m3bad)} violating fits out of "
          f"{sum(len(r['fits']) for r in rows)}")
    print("  movementSampleMaxStep 0.1 (fork default) vs 0.02, medians:")
    print(f"    {'family/shape':<22}{'rmse@0.1':>10}{'rmse@0.02':>11}"
          f"{'events@0.1':>12}{'events@0.02':>13}")
    for key in ("uniform-1|default", "uniform-0.25|default", "uniform-0.25|free",
                "rdp-200|default"):
        sub = [f for r in rows for f in r["fits"]
               if f["family"] + "|" + f["shape"] == key]
        if not sub:
            continue
        print(f"    {key:<22}"
              f"{med(sub,'rmse_rendered_step0.1'):>10.2f}"
              f"{med(sub,'rmse_rendered_step0.02'):>11.2f}"
              f"{med(sub,'n_cc_events_step0.1'):>12.0f}"
              f"{med(sub,'n_cc_events_step0.02'):>13.0f}")
    print("  bounded LS vs the clip-after-lsqr shortcut (real traces):")
    for gb in (1, 0.25):
        sub = [b for r in rows for b in r["bounded_vs_clipped"]
               if b["grid_beats"] == gb]
        if not sub:
            continue
        print(f"    uniform-{gb:<5} positions at a bound "
              f"{statistics.median([b['n_at_bound'] for b in sub]):>4.0f}"
              f" / {statistics.median([b['n_pos'] for b in sub]):>4.0f}"
              f"   RMSE bounded {statistics.median([b['rmse_bounded'] for b in sub]):6.2f}"
              f"  clipped {statistics.median([b['rmse_clipped'] for b in sub]):6.2f}"
              f"  (clip is "
              f"{statistics.median([b['rmse_clipped']-b['rmse_bounded'] for b in sub]):+.2f}"
              f" cc worse)")
    print(f"  tick<->ms extrapolation exposure (events past the last matched note): "
          f"median {statistics.median([r['n_obs_outside_note_range'] for r in rows]):.0f}"
          f" of {statistics.median([r['n_events'] for r in rows]):.0f} observations "
          f"(forward and inverse tick<->ms both extrapolate; see ScoreTimeMap)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", nargs="?", default="all", choices=["all", "validate"])
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--java-proof", action="store_true")
    ap.add_argument("--from-json", action="store_true",
                    help="re-print the report from out/pedal_fit.json (no refit)")
    args = ap.parse_args()

    if args.from_json:
        with open(os.path.join(OUT, "pedal_fit.json")) as fh:
            report(json.load(fh)["rows"])
        return 0

    print("=" * 78)
    print("Exactness proofs (project standard: 0-diff)")
    print("=" * 78)
    proofs = validate(java_proof=args.java_proof)
    if args.mode == "validate":
        return 0

    records = [json.loads(l) for l in open(DATA)]
    sel = select(records, args.n)
    print(f"\n{len(sel)} Vienna performances: "
          + ", ".join(sorted({r['piece'] for r in sel})))
    print("  selected: " + ", ".join(r["id"] for r in sel))

    t0 = time.time()
    rows = []
    for r in sel:
        row = analyse(r, quick=args.quick)
        rows.append(row)
        print(f"  {row['id']:<28} {row['n_events']:>5} cc events, "
              f"{row['duration_s']:6.1f} s, beat {row['beat_ms']:6.0f} ms, "
              f"burst {row['n_opening_burst']:>4} -> 1, "
              f"std {row['cc_std']:5.1f} cc, "
              f"{row['n_threshold_crossings']:>4} CC64-crossings", flush=True)
    print(f"  ({time.time() - t0:.0f} s)")

    report(rows)

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "pedal_fit.json"), "w") as fh:
        json.dump({"proofs": proofs, "rows": rows}, fh, indent=1, default=float)
    print(f"\nwrote {os.path.join(OUT, 'pedal_fit.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
