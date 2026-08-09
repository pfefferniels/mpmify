"""The representation ceiling: how much of the v1 sim2real error is the normal form?

The open question from LOG.md ("Sim2real probe v1 x Vienna 4x22", cause 2)
--------------------------------------------------------------------------
v1 inference on real performances gives median render RMSE 2889-8990 ms per piece,
against a ~404 ms constant-tempo baseline.  Two causes are confounded:

  1. **domain gap**   -- the sampler's score/tempo distribution is not the corpus's
     (fixable with domain randomisation), and
  2. **representation ceiling** -- the canonical form (>=4-beat monotone tempo
     segments, no rubato/asynchrony/imprecision) may simply be unable to express real
     beat-level tempo fluctuation, in which case NO model could do better.

This module measures (2) directly: for each Vienna window it fits the ORACLE
canonical tempo explanation -- the best map in the hypothesis class, fitted with full
knowledge of the target -- and reports the render RMSE it achieves.  Whatever the
oracle cannot explain is the ceiling; whatever the model loses relative to the oracle
is model failure.

Six explanations, in increasing power:

  const          one constant tempo (the LOG's baseline; `evaluate.constant_baseline`)
  stair-G        exact least-squares piecewise-constant staircase on a G-beat grid,
                 G in {8,4,2,1,0.5}; `staircase_fit.fit_staircase` (design matrix
                 proven to reproduce meico's constant-tempo rendering to 7e-12 ms)
  power-G        CANONICAL family: a continuous chain of meico power-function
                 transitions on a G-beat grid, tempo at each boundary and one
                 meanTempoAt per segment, fitted by bounded least squares over the
                 EXACT renderer (`tempo_math.TempoTimeline`), meanTempoAt confined to
                 the canonical [0.15, 0.85].  This is the strongest member of the v1/v3
                 tempo hypothesis class.
  greedy         sub-beat adaptive staircase (`staircase_fit.greedy_path`), i.e. the
                 rival that CANONICAL.md §A prices -- allowed to break every canonical
                 rule about boundary placement.
  isotonic       the best possible tick->ms map of ANY kind: per distinct score tick,
                 the mean of the performed onsets, made monotone (PAVA).  No tempoMap,
                 however dense, can beat this.  The residual is pure chord asynchrony.
  chord-floor    RMSE of each note against its own tick's mean onset = the part of the
                 signal that is asynchrony/imprecision by definition.

`isotonic` is the honest ceiling of the whole "tempo owns all timing" band (H1); the
gap between `power-4` (canonical) and `isotonic` is what finer canonical granularity
plus rubato/asynchrony/imprecision would have to buy.

Also reported per explanation: DL in canonical DSL tokens (`analysis/mdl.py`), so the
ceiling is a Pareto statement, not just a fidelity one; and a **DL-matched oracle**
(the best explanation costing no more tokens than the v1 model actually spent),
which isolates "the model spent its tokens badly" from "the tokens were not enough".
**One DL counter for every row**, the model's own map included: `mdl.dl_tempo_map`
re-prices `preds[...]["tempo_map"]` rather than trusting `infer.py`'s decoded token
count, which is a different unit (see `analyse`).

Two properties of the numbers that a reader has to know, both enforced in code and
printed by the run:
  * `select()` stratifies over pieces, pianists AND window index.  A stride selection
    aliases with this corpus's layout and silently returns nothing but `_w0`, i.e.
    piece openings (see the docstring there).  `report_window_mix` prints the mix.
  * `T1` in table A marks the rows that are inside the canonical hypothesis class
    (segments >= 4 beats).  `stair-2/1/0.5` and `greedy` are non-canonical rivals and
    every dominance count in table F is reported both ways.

Usage
-----
    nice -n 15 python3 vienna_ceiling.py                 # 40 windows (10 per piece),
                                                        # ~15 min
    nice -n 15 python3 vienna_ceiling.py validate        # exactness proofs only
    nice -n 15 python3 vienna_ceiling.py asynchrony      # section E only, seconds
    nice -n 15 python3 vienna_ceiling.py --n 8 --quick

Writes `analysis/out/vienna_ceiling.json`; prints the tables used by `findings_v4.md`.
Read-only w.r.t. everything else.
"""

import argparse
import json
import math
import os
import statistics
import sys
import time

import numpy as np
from scipy.optimize import least_squares

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "python"))
sys.path.insert(0, _HERE)

import evaluate as ev                                          # noqa: E402
import mdl                                                     # noqa: E402
import staircase_fit as sf                                     # noqa: E402
from tempo_math import PPQ, TempoTimeline                      # noqa: E402

WINDOWS = os.path.join(_HERE, "..", "data", "vienna_infer_windows.jsonl")
PREDS = os.path.join(_HERE, "..", "data", "vienna_infer_windows.preds.json")
OUT = os.path.join(_HERE, "out")

MTA_LO, MTA_HI = 0.15, 0.85          # CANONICAL.md T3
BPM_LO, BPM_HI = 10.0, 400.0
GREEDY_MAX_INSTR = 48                # same budget as findings.md §A
# Power-chain grids.  8 and 4 beats are the canonical family (T1: segments >= 4 beats);
# a 2-beat power chain costs ~33 s/window against ~10 s for 4 beats and only interpolates
# between stair-2 and stair-1, so it is not run by default.  Add 2 here to price it.
POWER_GRIDS = (8, 4)


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def note_arrays(rec):
    t = np.array([n[0] for n in rec["notes"]], dtype=float)
    y = np.array([n[3] for n in rec["notes"]], dtype=float)
    return t, y


def render_ms(tempo_map, ticks):
    """EXACT renderer (python/tempo_math, fdlibm-parity pow/log).  Reference."""
    tl = TempoTimeline(tempo_map)
    return np.array([tl.ms_at(t) for t in ticks], dtype=float)


# --- fast renderer -------------------------------------------------------- #
# tempo_math routes every pow/log through the fdlibm port so that renders are
# bit-identical to Java.  That costs ~15 us per pow (75x libm) and a power-chain
# fit needs ~1e6 of them per window, which is minutes.  The optimiser therefore
# runs on a vectorised libm copy of the SAME formulas; the reported RMSE is
# always recomputed with the exact renderer above, and `validate()` proves the two
# agree to <= 1e-9 ms (V4) -- 1-ULP pow differences are ~1e-13 relative, i.e. 8
# orders of magnitude below the errors this module measures.

MS_PER_TICK_AT_1BPM = 15000.0 / (0.25 * PPQ)
_JAVA_DOUBLE_MAX = 1.7976931348623157e308


def _seg_ms_fast(d, instr, end):
    d0, bpm, to, mta = instr
    d = np.asarray(d, dtype=float)
    if to is None or to == bpm:
        return (d - d0) * MS_PER_TICK_AT_1BPM / bpm
    exponent = math.log(0.5) / math.log(mta if mta else 0.5)
    span = end - d0

    def T(dd):
        x = (dd - d0) / span
        val = np.power(np.maximum(x, 0.0), exponent) * (to - bpm) + bpm
        return np.where(dd >= end, to, val)

    n2 = 2.0 * np.floor((d - d0) / (PPQ / 4))
    n2 = np.where(n2 == 0.0, 2.0, n2)
    n = (n2 / 2.0).astype(np.int64)
    x = (d - d0) / n2
    result_const = (d - d0) * 5000.0 / (n2 * 0.25 * PPQ)
    s = 1.0 / bpm + 1.0 / T(d)
    nmax = int(n.max()) if n.size else 1
    for k in range(1, nmax):
        m = k < n
        if not m.any():
            break
        s = s + np.where(m, 2.0 / T(d0 + 2 * k * x), 0.0)
    for k in range(1, nmax + 1):
        m = k <= n
        s = s + np.where(m, 4.0 / T(d0 + (2 * k - 1) * x), 0.0)
    return result_const * s


class FastTimeline:
    def __init__(self, tempo_map):
        self.instrs = tempo_map
        self.starts = [0.0]
        for i in range(len(tempo_map) - 1):
            end = tempo_map[i + 1][0]
            self.starts.append(self.starts[-1]
                               + float(_seg_ms_fast(np.array([end]),
                                                    tempo_map[i], end)[0]))

    def ms_at_many(self, ticks, seg_idx=None):
        ticks = np.asarray(ticks, dtype=float)
        dates = np.array([i[0] for i in self.instrs], dtype=float)
        if seg_idx is None:
            seg_idx = np.clip(np.searchsorted(dates, ticks, side="right") - 1,
                              0, len(self.instrs) - 1)
        out = np.empty(len(ticks))
        for i in range(len(self.instrs)):
            k = seg_idx == i
            if not k.any():
                continue
            end = (self.instrs[i + 1][0] if i + 1 < len(self.instrs)
                   else _JAVA_DOUBLE_MAX)
            out[k] = self.starts[i] + _seg_ms_fast(ticks[k], self.instrs[i], end)
        return out


def rmse(tempo_map, ticks, y):
    return float(np.sqrt(np.mean((render_ms(tempo_map, ticks) - y) ** 2)))


def isotonic_floor(ticks, y):
    """PAVA on the per-tick means -> the best monotone tick->ms map, and its RMSE.

    Weighted by the number of notes at each tick, so the objective is exactly the
    note-level SSE that render_rmse measures.
    """
    order = np.argsort(ticks, kind="stable")
    t, yy = ticks[order], y[order]
    ut, inv = np.unique(t, return_inverse=True)
    w = np.bincount(inv).astype(float)
    m = np.bincount(inv, weights=yy) / w
    # pool-adjacent-violators (weighted), non-decreasing
    vals, wts = [], []
    for vi, wi in zip(m, w):
        vals.append(vi); wts.append(wi)
        while len(vals) > 1 and vals[-2] > vals[-1]:
            v2, w2 = vals.pop(), wts.pop()
            v1, w1 = vals.pop(), wts.pop()
            vals.append((v1 * w1 + v2 * w2) / (w1 + w2)); wts.append(w1 + w2)
    fit = np.repeat(vals, [int(round(x)) for x in _run_lengths(wts, w)])
    pred = fit[inv]
    return float(np.sqrt(np.mean((pred - yy) ** 2))), float(
        np.sqrt(np.mean((m[inv] - yy) ** 2)))


def _run_lengths(pooled_w, w):
    """How many original tick-groups each pooled block covers."""
    out, i = [], 0
    for pw in pooled_w:
        acc, k = 0.0, 0
        while i < len(w) and acc + 1e-9 < pw:
            acc += w[i]; i += 1; k += 1
        out.append(k)
    return out


# --------------------------------------------------------------------------- #
# canonical power-transition chain (the actual v1/v3 hypothesis class)
# --------------------------------------------------------------------------- #

def _chain_map(bounds, tempi, mtas):
    m = []
    for j in range(len(bounds) - 1):
        if abs(tempi[j + 1] - tempi[j]) < 1e-9:
            m.append([float(bounds[j]), float(tempi[j]), None, None])
        else:
            m.append([float(bounds[j]), float(tempi[j]),
                      float(tempi[j + 1]), float(mtas[j])])
    m.append([float(bounds[-1]), float(tempi[-1]), None, None])
    return m


def fit_power_chain(rec, grid_beats, nfev_per_param=40):
    """Continuous chain of power transitions on a `grid_beats` grid, exact renderer.

    Free parameters: one tempo per boundary (log-scale) + one meanTempoAt per segment
    (logit-scale, confined to the canonical [0.15, 0.85]).  Initialised from the exact
    staircase fit on the same grid, which makes this a strict improvement on it.
    """
    ticks, y = note_arrays(rec)
    total = max(n[0] + n[1] for n in rec["notes"])
    bounds = list(sf.grid_boundaries(total, grid_beats))
    if int(math.ceil(total)) > bounds[-1]:
        bounds.append(int(math.ceil(total)))
    n_seg = len(bounds) - 1
    if n_seg < 1:
        return ev.constant_baseline(rec), float("nan"), 0

    stair = sf.fit_staircase(rec, grid_beats, merge=False)
    seg_bpm = np.array([s[1] for s in stair], dtype=float)
    if len(seg_bpm) < n_seg:
        seg_bpm = np.concatenate([seg_bpm,
                                  np.full(n_seg - len(seg_bpm), seg_bpm[-1])])
    seg_bpm = np.clip(seg_bpm[:n_seg], BPM_LO, BPM_HI)
    tempi0 = np.empty(n_seg + 1)
    tempi0[0] = seg_bpm[0]
    tempi0[-1] = seg_bpm[-1]
    tempi0[1:-1] = 0.5 * (seg_bpm[:-1] + seg_bpm[1:])
    x0 = np.concatenate([np.log(tempi0), np.zeros(n_seg)])   # logit(0.5) = 0

    lo = np.concatenate([np.full(n_seg + 1, math.log(BPM_LO)),
                         np.full(n_seg, _logit((MTA_LO - 0.0) / 1.0))])
    hi = np.concatenate([np.full(n_seg + 1, math.log(BPM_HI)),
                         np.full(n_seg, _logit(MTA_HI))])

    def unpack(x):
        tempi = np.exp(x[:n_seg + 1])
        mtas = _sigmoid(x[n_seg + 1:])
        return tempi, np.clip(mtas, MTA_LO, MTA_HI)

    seg_idx = np.clip(np.searchsorted(np.array(bounds, dtype=float), ticks,
                                      side="right") - 1, 0, n_seg)

    def resid(x):
        tempi, mtas = unpack(x)
        try:
            tm = _chain_map(bounds, tempi, mtas)
            r = FastTimeline(tm).ms_at_many(ticks, seg_idx) - y
        except (ValueError, ZeroDivisionError, OverflowError):
            return np.full(len(y), 1e6)
        return np.nan_to_num(r, nan=1e6, posinf=1e6, neginf=1e6)

    res = least_squares(resid, x0, bounds=(lo, hi),
                        max_nfev=min(4000, nfev_per_param * len(x0)),
                        xtol=1e-10, ftol=1e-10, gtol=1e-10)
    tempi, mtas = unpack(res.x)
    tmap = _chain_map(bounds, np.round(tempi, 1), np.round(mtas, 2))
    tmap = _canonicalise(tmap)
    return tmap, rmse(tmap, ticks, y), res.nfev


def _logit(p):
    return math.log(p / (1.0 - p))


def _sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -40, 40)))


def _canonicalise(tmap):
    """CANONICAL.md §6 rewrites that matter here: degenerate transitions -> constant,
    last instruction constant, merge adjacent equal constants."""
    out = []
    for d, bpm, to, mta in tmap:
        if to is not None and (to == bpm or mta is None
                               or mta <= 0.0 or mta >= 1.0):
            to, mta = None, None
        out.append([d, bpm, to, mta])
    out[-1][2] = out[-1][3] = None
    merged = [out[0]]
    for ins in out[1:]:
        prev = merged[-1]
        if prev[2] is None and ins[2] is None and prev[1] == ins[1]:
            continue
        merged.append(ins)
    return merged


# --------------------------------------------------------------------------- #
# per-window experiment
# --------------------------------------------------------------------------- #

def analyse(rec, preds, quick=False):
    ticks, y = note_arrays(rec)
    n_notes = len(ticks)
    total = max(n[0] + n[1] for n in rec["notes"])
    dur_s = float(y.max() - y.min()) / 1000.0
    beats = total / PPQ

    rows = {}
    const = ev.constant_baseline(rec)
    const[0][1] = round(const[0][1], 1)
    rows["const"] = {"rmse": rmse(const, ticks, y), "dl": mdl.dl_tempo_map(const),
                     "n_instr": len(const)}

    grids = (8, 4, 2, 1) if quick else (8, 4, 2, 1, 0.5)
    for g in grids:
        tmap = sf.fit_staircase(rec, g)
        rows[f"stair-{g}"] = {"rmse": rmse(tmap, ticks, y),
                              "dl": mdl.dl_tempo_map(tmap), "n_instr": len(tmap)}
    for g in ((8,) if quick else POWER_GRIDS):
        tmap, r, nfev = fit_power_chain(rec, g)
        rows[f"power-{g}"] = {"rmse": r, "dl": mdl.dl_tempo_map(tmap),
                              "n_instr": len(tmap), "nfev": nfev}

    path = sf.greedy_path(rec, target_rmse=0.0, max_instr=GREEDY_MAX_INSTR)
    greedy = [{"n_instr": p["n_instr"], "rmse": p["rmse"],
               "dl": mdl.dl_tempo_map(p["map"], integer_dates=False)} for p in path]
    rows["greedy-best"] = {"rmse": greedy[-1]["rmse"], "dl": greedy[-1]["dl"],
                           "n_instr": greedy[-1]["n_instr"]}

    iso, means = isotonic_floor(ticks, y)
    rows["isotonic"] = {"rmse": iso, "dl": None, "n_instr": None}
    rows["chord-floor"] = {"rmse": means, "dl": None, "n_instr": None}

    pred = preds.get(rec["id"])
    if pred:
        # DL accounting must use ONE counter for every row of the table.  `infer.py`
        # stores `dl_tokens = len(decoded ids)`, which counts the dynamics production
        # and any structural tokens too; every competitor here is priced by
        # `mdl.dl_tempo_map`.  Comparing the oracle's mdl-DL against the model's
        # decoded-length is a unit mismatch (they differ by up to ~20 tokens on these
        # maps), so the budget is the model's own tempoMap re-priced with mdl.
        dl_mdl = mdl.dl_tempo_map(pred["tempo_map"])
        rows["v1-model"] = {"rmse": pred["render_rmse"], "dl": dl_mdl,
                            "dl_decoded": pred["dl_tokens"],
                            "n_instr": pred["n_tempo"]}
        budget = dl_mdl
        best = None
        for name, r in rows.items():
            if r.get("dl") is None or name.startswith("v1"):
                continue
            if r["dl"] <= budget and (best is None or r["rmse"] < best[1]):
                best = (name, r["rmse"], r["dl"])
        for p in greedy:
            if p["dl"] <= budget and (best is None or p["rmse"] < best[1]):
                best = (f"greedy@{p['n_instr']}", p["rmse"], p["dl"])
        if best:
            rows["dl-matched-oracle"] = {"rmse": best[1], "dl": best[2],
                                         "n_instr": None, "family": best[0]}

    return {"id": rec["id"], "piece": rec["piece"], "pianist": rec["pianist"],
            "n_notes": n_notes, "beats": beats, "duration_s": dur_s,
            "beat_ms": 1000.0 * dur_s / beats if beats else float("nan"),
            "distinct_ticks": int(len(np.unique(ticks))),
            "rows": rows, "greedy_path": greedy}


# --------------------------------------------------------------------------- #

def validate(verbose=True):
    res = {}
    w = sf.validate_design_matrix()
    res["V1_staircase_design_matrix"] = w
    if verbose:
        print(f"V1 staircase design matrix vs meico constant-tempo rendering : "
              f"max |diff| = {w:.12f} ms (200 staircases x 40 notes)")
    # V2: the power-chain builder must round-trip through TempoTimeline unchanged,
    # and a degenerate chain (all tempi equal) must equal the constant rendering.
    rng = np.random.default_rng(3)
    worst = 0.0
    for _ in range(200):
        n_seg = int(rng.integers(1, 6))
        bounds = [j * 4 * PPQ for j in range(n_seg + 1)]
        bpm = float(np.exp(rng.uniform(math.log(40), math.log(200))))
        tempi = np.full(n_seg + 1, bpm)
        tmap = _chain_map(bounds, tempi, np.full(n_seg, 0.5))
        ticks = np.sort(rng.integers(0, bounds[-1], size=30).astype(float))
        got = render_ms(tmap, ticks)
        ref = 15000.0 * ticks / (bpm * 0.25 * PPQ)
        worst = max(worst, float(np.max(np.abs(got - ref))))
    res["V2_degenerate_power_chain_vs_constant"] = worst
    if verbose:
        print(f"V2 degenerate power chain vs closed-form constant tempo       : "
              f"max |diff| = {worst:.12f} ms (200 chains x 30 notes)")
    # V3: isotonic floor <= chord floor <= any staircase, on real windows
    recs = [json.loads(l) for l in open(WINDOWS)][:20]
    bad = 0
    for r in recs:
        t, y = note_arrays(r)
        iso, ch = isotonic_floor(t, y)
        st = rmse(sf.fit_staircase(r, 1), t, y)
        if not (iso <= ch + 1e-9 and ch <= st + 1e-9):
            bad += 1
    res["V3_floor_ordering_violations"] = bad
    if verbose:
        print(f"V3 isotonic <= chord-mean <= 1-beat staircase on 20 windows   : "
              f"{bad} violations")
    # V4: the fast (libm) renderer used inside the optimiser vs the exact
    # (fdlibm-parity) renderer that produces every reported number.
    worst = 0.0
    n_cases = 0
    for _ in range(120):
        n_seg = int(rng.integers(1, 7))
        bounds = [j * int(rng.integers(2, 9)) * PPQ for j in range(n_seg + 1)]
        bounds = sorted(set(bounds))
        if len(bounds) < 2:
            continue
        n_seg = len(bounds) - 1
        tempi = np.exp(rng.uniform(math.log(30), math.log(240), n_seg + 1)).round(1)
        mtas = rng.uniform(MTA_LO, MTA_HI, n_seg).round(2)
        tmap = _chain_map(bounds, tempi, mtas)
        ticks = np.sort(rng.uniform(0, bounds[-1], size=60))
        a = FastTimeline(tmap).ms_at_many(ticks)
        b = render_ms(tmap, ticks)
        worst = max(worst, float(np.max(np.abs(a - b))))
        n_cases += 1
    res["V4_fast_vs_exact_renderer_ms"] = worst
    if verbose:
        print(f"V4 fast (libm) power renderer vs exact (fdlibm) tempo_math    : "
              f"max |diff| = {worst:.12f} ms ({n_cases} chains x 60 notes)")
    return res


# --------------------------------------------------------------------------- #
# asynchrony: how much of real chord spread is a CONSTANT per-part offset?
# --------------------------------------------------------------------------- #

def asynchrony_stats(rec):
    """Treat "top voice" vs "the rest" as the two parts an asynchronyMap would model.

    For every score tick carrying >= 2 notes, lead = mean(onset of lower notes)
    - onset(highest note).  A canonical asynchronyMap can only express a CONSTANT
    offset per part per span, so the share of the lead's **second moment** that a
    single constant explains is mu^2 / (mu^2 + var) -- the rest is, by construction,
    imprecision (v5), not asynchrony.

    Note the name: this is a share of E[lead^2], NOT a share of Var[lead] (a constant
    explains 0 % of the variance by definition).  Earlier write-ups called it a
    "variance share"; `share_of_second_moment` is what it is.  It is also not robust
    across windows -- p10 is ~0.06 -- so the median must be quoted with its spread.
    """
    by_tick = {}
    for n in rec["notes"]:
        by_tick.setdefault(int(n[0]), []).append((int(n[2]), float(n[3])))
    leads = []
    for t, ns in by_tick.items():
        if len(ns) < 2:
            continue
        top = max(ns)[0]
        hi = [ms for p, ms in ns if p == top]
        lo = [ms for p, ms in ns if p != top]
        if not lo:
            continue
        leads.append(float(np.mean(lo) - np.mean(hi)))
    if len(leads) < 5:
        return None
    a = np.array(leads)
    mu, var = float(a.mean()), float(a.var())
    return {"n_chords": len(a), "mean_lead_ms": mu, "median_lead_ms": float(np.median(a)),
            "sd_lead_ms": math.sqrt(var), "p10": float(np.percentile(a, 10)),
            "p90": float(np.percentile(a, 90)), "positive_mean_lead": bool(mu > 0),
            "share_of_second_moment": mu * mu / (mu * mu + var) if var >= 0 else 1.0}


def report_asynchrony(records, n, sel=None):
    sel = sel if sel is not None else select(records, n)
    stats = [s for s in (asynchrony_stats(r) for r in sel) if s]
    print("\n" + "=" * 84)
    print(f"E. Chord asynchrony ('top voice' vs 'the rest'), {len(stats)} windows")
    print("=" * 84)
    print(f"{'quantity':<44}{'median':>10}{'p10':>10}{'p90':>10}")
    for key, label in (("median_lead_ms", "per-window median lead (ms)"),
                       ("mean_lead_ms", "per-window mean lead (ms)"),
                       ("sd_lead_ms", "per-window sd of the lead (ms)"),
                       ("share_of_second_moment",
                        "share of the SECOND MOMENT a constant explains")):
        v = sorted(s[key] for s in stats)
        print(f"{label:<44}{statistics.median(v):>10.3f}"
              f"{v[int(0.1*(len(v)-1))]:>10.3f}{v[int(0.9*(len(v)-1))]:>10.3f}")
    print(f"{'chords per window':<44}"
          f"{statistics.median([s['n_chords'] for s in stats]):>10.0f}")
    print(f"{'windows with a POSITIVE mean lead':<44}"
          f"{sum(1 for s in stats if s['positive_mean_lead']):>7}/{len(stats)}")
    print("  note: mu^2/(mu^2+var) is a share of E[lead^2], not of Var[lead]; and it "
          "is not\n  robust across windows (p10 above), so quote it with its spread.")
    return stats


SELECT_SEED = 20260809


def select(records, n, seed=SELECT_SEED):
    """`n` windows stratified over pieces, pianists AND window position.

    The obvious stride selection (`sorted(by_piece[p])[::step][:per]`) ALIASES with
    this corpus's layout: each performance contributes 2-3 consecutive windows to the
    sorted id order, so an even stride lands on the same window index every time.  On
    the 220-window corpus (88 w0 + 88 w1 + 44 w2) it selected `_w0` for all 40
    windows, i.e. it measured piece OPENINGS and reported them as a sample of the
    corpus.  (Visible in the output: the per-piece v1 medians came out 9108/4181/
    2494/2445 against LOG.md's all-window 8990/3959/3565/2889.)

    This version is explicit about both axes: per piece, deterministically permute the
    pianists, take `per` of them, and rotate the window index across the chosen
    pianists so w0/w1/w2 all appear.  `report_window_mix` prints the realised mix so
    the property is auditable from the log.
    """
    by_piece = {}
    for r in records:
        by_piece.setdefault(r["piece"], []).append(r)
    pieces = sorted(by_piece)
    per = max(1, n // len(pieces))
    out = []
    for pi, p in enumerate(pieces):
        by_perf = {}
        for r in by_piece[p]:
            by_perf.setdefault(r["pianist"], []).append(r)
        perfs = sorted(by_perf)
        order = np.random.default_rng(seed + pi).permutation(len(perfs))
        for k, idx in enumerate(order[:per]):
            ws = sorted(by_perf[perfs[int(idx)]], key=lambda r: r["id"])
            out.append(ws[k % len(ws)])
    return out[:n]


def report_window_mix(sel):
    """Print the realised piece / pianist / window-index mix of a selection."""
    from collections import Counter
    wi = Counter(r["id"].rsplit("_", 1)[1] for r in sel)
    print(f"  window-index mix: " + ", ".join(f"{k}={v}" for k, v in sorted(wi.items()))
          + f"   distinct pianists: {len(set(r['pianist'] for r in sel))}")


ORDER = ["const", "stair-8", "power-8", "stair-4", "power-4", "stair-2", "power-2",
         "stair-1", "stair-0.5", "greedy-best", "dl-matched-oracle", "v1-model",
         "isotonic", "chord-floor"]

# CANONICAL.md T1: a canonical tempo segment is >= 4 beats.  `stair-2/1/0.5` are
# therefore NON-canonical competitors; a dominance count that quietly includes them
# is not a statement about the canonical hypothesis class (findings_v4 §B4 / D2).
CANONICAL_STAIRS = ["stair-8", "stair-4"]
ALL_STAIRS = ["stair-8", "stair-4", "stair-2", "stair-1", "stair-0.5"]


def _ratio(rows, a, b, key="rmse"):
    """Median of PER-WINDOW ratios a/b (the documents' aggregation convention)."""
    v = [w["rows"][a][key] / w["rows"][b][key] for w in rows
         if a in w["rows"] and b in w["rows"]
         and w["rows"][a].get(key) is not None and w["rows"][b].get(key)]
    return statistics.median(v) if v else float("nan")


def _dominates(rows, challengers, target):
    """Per window: does some challenger cost <= target's DL and beat its RMSE?

    Returns (n_windows_dominated, n_windows_compared, Counter of winning family).
    """
    from collections import Counter
    n = k = 0
    who = Counter()
    for w in rows:
        rr = w["rows"]
        if target not in rr or rr[target].get("dl") is None:
            continue
        k += 1
        win = [c for c in challengers if c in rr and rr[c].get("dl") is not None
               and rr[c]["dl"] <= rr[target]["dl"] and rr[c]["rmse"] < rr[target]["rmse"]]
        if win:
            n += 1
            who[min(win, key=lambda c: rr[c]["rmse"])] += 1
    return n, k, who


def report_paired_checks(rows):
    """The paired statistics quoted by findings_v4 §B4 and CANONICAL.md §14 D2.

    Previously computed ad hoc from the JSON and pasted into the write-ups; it now
    comes out of the run that produced the numbers.
    """
    print("\n" + "=" * 84)
    print("F. Paired checks (medians of per-window ratios; n = %d windows)" % len(rows))
    print("=" * 84)
    for a, b in (("stair-4", "power-8"), ("stair-2", "power-4"),
                 ("power-4", "stair-4"), ("power-8", "stair-8")):
        if not (any(a in w["rows"] for w in rows) and any(b in w["rows"] for w in rows)):
            continue
        print(f"  {a:<12} / {b:<12} rmse ratio {_ratio(rows, a, b):>6.2f}"
              f"   dl ratio {_ratio(rows, a, b, 'dl'):>6.2f}")
    print()
    for name in ("power-4", "dl-matched-oracle", "isotonic", "const", "greedy-best"):
        if any(name in w["rows"] for w in rows):
            print(f"  {name:<18} / v1-model = {_ratio(rows, name, 'v1-model'):.4f}")
    worse = sum(1 for w in rows if "v1-model" in w["rows"]
                and w["rows"]["v1-model"]["rmse"] > w["rows"]["const"]["rmse"])
    n_v1 = sum(1 for w in rows if "v1-model" in w["rows"])
    print(f"\n  windows where v1 is WORSE than the constant baseline: {worse}/{n_v1}")
    for label, chal in (("CANONICAL staircases only (>=4 beats)", CANONICAL_STAIRS),
                        ("ANY staircase incl. non-canonical 2/1/0.5", ALL_STAIRS)):
        for target in ("power-4", "power-8"):
            if not any(target in w["rows"] for w in rows):
                continue
            n, k, who = _dominates(rows, chal, target)
            detail = ", ".join(f"{c}:{v}" for c, v in who.most_common())
            print(f"  dominates {target:<8} [{label:<41}]: {n}/{k}"
                  + (f"   ({detail})" if detail else ""))
    n, k, _ = _dominates(rows, ["power-8", "power-4"], "stair-2")
    print(f"  windows where a power chain dominates stair-2: {n}/{k}")
    n, k, _ = _dominates(rows, ["power-8", "power-4"], "stair-4")
    print(f"  windows where a power chain dominates stair-4: {n}/{k}")
    same = sum(1 for w in rows
               if abs(w["rows"]["isotonic"]["rmse"]
                      - w["rows"]["chord-floor"]["rmse"]) < 1e-9)
    print(f"\n  isotonic == chord-floor: {same}/{len(rows)} windows")
    for name in ("stair-0.5", "stair-1", "power-4"):
        if any(name in w["rows"] for w in rows):
            print(f"  {name:<10} / floor = {_ratio(rows, name, 'isotonic'):.2f}")
    dlm = [w["rows"]["v1-model"] for w in rows if "v1-model" in w["rows"]]
    if dlm and "dl_decoded" in dlm[0]:
        print(f"\n  v1 DL: mdl.dl_tempo_map median "
              f"{statistics.median([d['dl'] for d in dlm]):.0f} tokens vs "
              f"infer.py decoded-length median "
              f"{statistics.median([d['dl_decoded'] for d in dlm]):.0f}"
              f"   (the budget above uses the former, for unit consistency)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", nargs="?", default="all",
                    choices=["all", "validate", "asynchrony"])
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--from-json", action="store_true",
                    help="re-print the report from out/vienna_ceiling.json (no refit)")
    args = ap.parse_args()

    if args.from_json:
        with open(os.path.join(OUT, "vienna_ceiling.json")) as fh:
            blob = json.load(fh)
        report(blob["windows"])
        report_paired_checks(blob["windows"])
        return 0

    if args.mode == "asynchrony":
        recs = [json.loads(l) for l in open(WINDOWS)]
        sel = select(recs, args.n)
        report_window_mix(sel)
        report_asynchrony(recs, args.n, sel=sel)
        return 0

    print("=" * 84)
    print("Exactness proofs (project standard: <= 1e-9 ms)")
    print("=" * 84)
    proofs = validate()
    if args.mode == "validate":
        return 0

    records = [json.loads(l) for l in open(WINDOWS)]
    preds = {p["id"]: p for p in json.load(open(PREDS))}
    sel = select(records, args.n)
    print(f"\n{len(sel)} Vienna windows over "
          f"{len(set(r['piece'] for r in sel))} pieces, "
          f"{len(set(r['pianist'] for r in sel))} pianists")
    report_window_mix(sel)

    os.makedirs(OUT, exist_ok=True)
    partial = os.path.join(OUT, "vienna_ceiling.partial.json")
    t0 = time.time()
    rows = []
    for i, r in enumerate(sel):
        w = analyse(r, preds, quick=args.quick)
        rows.append(w)
        rr = w["rows"]
        print(f"  [{i+1:>2}/{len(sel)}] {w['id']:<28} "
              f"const {rr['const']['rmse']:>7.0f} | power-4 "
              f"{rr.get('power-4', {}).get('rmse', float('nan')):>7.1f} | greedy "
              f"{rr['greedy-best']['rmse']:>6.1f} | floor "
              f"{rr['isotonic']['rmse']:>6.1f} | v1 "
              f"{rr.get('v1-model', {}).get('rmse', float('nan')):>8.0f}"
              f"   ({time.time() - t0:.0f} s)", flush=True)
        with open(partial, "w") as fh:      # survive an interrupted run
            json.dump({"windows": rows}, fh, default=float)
    print(f"  ({time.time() - t0:.0f} s)")
    report(rows)
    asyn = report_asynchrony(records, args.n, sel=sel)
    report_paired_checks(rows)

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "vienna_ceiling.json"), "w") as fh:
        json.dump({"proofs": proofs, "windows": rows, "asynchrony": asyn},
                  fh, indent=1, default=float)
    print(f"\nwrote {os.path.join(OUT, 'vienna_ceiling.json')}")
    return 0


def report(rows):
    """Tables A-D of findings_v4 §B, from already-computed windows."""

    def stat(name, key, subset=None, f=statistics.median):
        v = [w["rows"][name][key] for w in (subset or rows)
             if name in w["rows"] and w["rows"][name].get(key) is not None]
        return f(v) if v else float("nan")

    print("\n" + "=" * 84)
    print(f"A. Representation ceiling -- render RMSE (ms), medians over "
          f"{len(rows)} windows")
    print("=" * 84)
    print("DL is `mdl.dl_tempo_map` for EVERY row, the v1 model included.  'T1' marks "
          "the rows\ninside the canonical hypothesis class (segments >= 4 beats); "
          "stair-2/1/0.5 and greedy\nare deliberately NON-canonical competitors.")
    print(f"{'explanation':<20}{'T1':>4}{'RMSE med':>10}{'RMSE p90':>10}{'DL med':>9}"
          f"{'instr':>7}{'vs const':>10}")
    base = stat("const", "rmse")
    canon = {"const", "stair-8", "stair-4", "power-8", "power-4"}
    for name in ORDER:
        if not any(name in w["rows"] for w in rows):
            continue
        print(f"{name:<20}{('yes' if name in canon else '-'):>4}", end="")
        r = stat(name, "rmse")
        p90 = stat(name, "rmse", f=lambda v: sorted(v)[min(len(v) - 1,
                                                           int(0.9 * len(v)))])
        dl = stat(name, "dl")
        ni = stat(name, "n_instr")
        print(f"{r:>10.1f}{p90:>10.1f}"
              f"{('%.0f' % dl) if dl == dl else '-':>9}"
              f"{('%.0f' % ni) if ni == ni else '-':>7}"
              f"{r / base:>10.2f}")

    print("\n" + "=" * 84)
    print("B. Per piece (median over its windows)")
    print("=" * 84)
    hdr = ["const", "stair-4", "power-4", "stair-1", "stair-0.5", "greedy-best",
           "isotonic", "chord-floor", "v1-model"]
    print(f"{'piece':<22}{'beat ms':>8}{'notes':>7}" + "".join(f"{h:>13}" for h in hdr))
    for piece in sorted({w["piece"] for w in rows}):
        sub = [w for w in rows if w["piece"] == piece]
        line = (f"{piece:<22}"
                f"{statistics.median([w['beat_ms'] for w in sub]):>8.0f}"
                f"{statistics.median([w['n_notes'] for w in sub]):>7.0f}")
        for h in hdr:
            line += f"{stat(h, 'rmse', sub):>13.1f}"
        print(line)

    print("\n" + "=" * 84)
    print("C. Decomposition of the v1 sim2real error (medians)")
    print("=" * 84)
    for piece in sorted({w["piece"] for w in rows}):
        sub = [w for w in rows if w["piece"] == piece]
        v1 = stat("v1-model", "rmse", sub)
        ceil4 = stat("power-4", "rmse", sub)
        ceilg = stat("greedy-best", "rmse", sub)
        iso = stat("isotonic", "rmse", sub)
        dlm = stat("dl-matched-oracle", "rmse", sub)
        print(f"  {piece:<22} v1 {v1:>8.0f} | canonical ceiling (power-4) {ceil4:>7.1f}"
              f" | DL-matched oracle {dlm:>7.1f} | sub-beat greedy {ceilg:>6.1f}"
              f" | any-tempo floor {iso:>6.1f}")
        if v1 == v1 and ceil4 == ceil4:
            print(f"  {'':<22} -> ceiling explains {100*ceil4/v1:5.1f} % of the v1 "
                  f"error; model failure {100*(v1-ceil4)/v1:5.1f} %")

    print("\n" + "=" * 84)
    print("D. Canonical granularity real playing demands "
          "(median RMSE by segment length)")
    print("=" * 84)
    for name in ["stair-8", "stair-4", "stair-2", "stair-1", "stair-0.5"]:
        if not any(name in w["rows"] for w in rows):
            continue
        g = float(name.split("-")[1])
        segms = statistics.median([w["beat_ms"] * g for w in rows])
        print(f"  {name:<10} segment {g:>4} beats = {segms:>6.0f} ms   "
              f"RMSE {stat(name,'rmse'):>7.1f} ms   DL {stat(name,'dl'):>5.0f} tokens")


if __name__ == "__main__":
    sys.exit(main())
