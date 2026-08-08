"""Description length (MDL) for canonical MPM, plus the fidelity metrics it trades against.

Makes the project goal "most efficient and natural representation" operational:

    DL(piece)   = number of canonical-DSL tokens needed to write the MPM down
                  (excluding <bos>/<eos>) -- the *model* cost
    L(data|M)   = Gaussian code length of the render residual at 1 ms resolution
                  -- the *fidelity* cost
    total_bits  = DL * log2(|V|) + L(data|M)     (two-part MDL)

The token counter is byte-exact with `python/dsl.py::encode_piece` for every map that
DSL can express (verified over the whole of data/val_v2.jsonl by `selftest()`:
0 mismatches / 1000 pieces). It additionally supports

  * fractional beat dates (sub-beat staircase boundaries), and
  * the proposed v3 maps (rubato, articulation) that dsl.py does not yet emit,

so that competing explanations can be priced on the same scale. See ../CANONICAL.md
for the v3 grammar these costs correspond to.

Nothing here mutates state; import it or run `python3 mdl.py` for the self-test.
"""

import json
import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "python"))

import dsl                                            # noqa: E402
from tempo_math import PPQ, TempoTimeline             # noqa: E402
import evaluate as ev                                 # noqa: E402

VOCAB_SIZE = len(dsl.VOCAB)          # 24 with the v2 vocab
BITS_PER_TOKEN = math.log2(VOCAB_SIZE)
MS_RESOLUTION = 1.0                  # residual quantisation for the data code
VEL_RESOLUTION = 1.0                 # MIDI velocity is integral


# --------------------------------------------------------------------------- #
# token counting (mirrors dsl._num_tokens exactly)
# --------------------------------------------------------------------------- #

def n_num_tokens(x):
    """Digit/'.'/'-' token count of a number, identical to dsl._num_tokens."""
    return len(dsl._num_tokens(x))


def _beats(date_ticks, ppq=PPQ, integer_dates=True):
    """Beat-valued date as the DSL writes it.

    Canonical form guarantees integer beats, and dsl.encode_* rounds; a competing
    explanation with sub-beat boundaries must spend the extra digit tokens.
    """
    b = date_ticks / ppq
    if integer_dates:
        return round(b)
    r = round(b, 3)
    return int(r) if r == int(r) else r


def dl_tempo_map(tempo_map, ppq=PPQ, integer_dates=True):
    """DL of a tempoMap: T <date> B <bpm> ( C | R <to> M <mta> )."""
    n = 0
    for date, bpm, to, mta in tempo_map:
        n += 1 + n_num_tokens(_beats(date, ppq, integer_dates))    # T <date>
        n += 1 + n_num_tokens(bpm)                                 # B <bpm>
        if to is None:
            n += 1                                                 # C
        else:
            n += 1 + n_num_tokens(to)                              # R <to>
            n += 1 + n_num_tokens(mta)                             # M <mta>
    return n


def dl_dynamics_map(dyn_map, ppq=PPQ, integer_dates=True):
    """DL of a dynamicsMap: D <date> V <vol> ( C | R <to> Q <curv> P <prot> )."""
    n = 0
    for date, vol, to, curv, prot in dyn_map:
        n += 1 + n_num_tokens(_beats(date, ppq, integer_dates))
        n += 1 + n_num_tokens(vol)
        if to is None:
            n += 1
        else:
            n += 1 + n_num_tokens(to)
            n += 1 + n_num_tokens(curv)
            n += 1 + n_num_tokens(prot)
    return n


# ---- proposed v3 maps (not yet in dsl.py; grammar specified in ../CANONICAL.md) ----

def dl_rubato_span(date_ticks, frame_ticks, intensity, end_ticks,
                   late_start=None, early_end=None, ppq=PPQ, integer_dates=True):
    """DL of one rubato span:  U <date> F <frame_beats> I <int> X <end>
    plus, ONLY for a non-canonical span, ' S <lateStart> E <earlyEnd>'.

    `X <end>` is the neutral terminator (intensity 1, lateStart 0, earlyEnd 1,
    frameLength inherited) that canonical form requires so the warp cannot leak
    into the rest of the piece.

    Canonical form (CANONICAL.md R2) pins lateStart=0 / earlyEnd=1, which is why the
    v3 grammar has no slot for them.  The shipped sampler
    (java/SampleAndRender.java:333-339) still emits lateStart in (0, 0.15] and
    earlyEnd in [0.85, 1) on 20 % of spans; such a span is NOT expressible in the
    canonical DSL and must not be priced as if it were.  Pass the two values
    explicitly to price it honestly with the 'S'/'E' extension (+2 tokens +digits);
    omitting them asserts the canonical 0/1.
    """
    n = 1 + n_num_tokens(_beats(date_ticks, ppq, integer_dates))
    n += 1 + n_num_tokens(_beats(frame_ticks, ppq, integer_dates))
    n += 1 + n_num_tokens(intensity)
    n += 1 + n_num_tokens(_beats(end_ticks, ppq, integer_dates))
    canonical = (late_start in (None, 0, 0.0)) and (early_end in (None, 1, 1.0))
    if not canonical:
        n += 1 + n_num_tokens(0.0 if late_start is None else late_start)
        n += 1 + n_num_tokens(1.0 if early_end is None else early_end)
    return n


def dl_rubato_map(spans, ppq=PPQ, integer_dates=True):
    """`spans`: (date, frame, intensity, end) or (date, frame, intensity, end,
    lateStart, earlyEnd)."""
    return sum(dl_rubato_span(*s, ppq=ppq, integer_dates=integer_dates) for s in spans)


def dl_articulation_map(artic, ppq=PPQ):
    """DL of an articulationMap: A <date> L <relDur> W <velChange> per affected date.

    Articulation dates are note onsets, i.e. generally NOT beat-aligned, so they are
    always priced with fractional beats.
    """
    n = 0
    for date, rel_dur, vel_change in artic:
        n += 1 + n_num_tokens(_beats(date, ppq, integer_dates=False))
        n += 1 + n_num_tokens(rel_dur)
        n += 1 + n_num_tokens(vel_change)
    return n


def dl_piece(tempo_map=(), dyn_map=(), rubato=(), artic=(), ppq=PPQ,
             integer_dates=True):
    """Total description length of one piece's canonical MPM, in DSL tokens."""
    return (dl_tempo_map(tempo_map, ppq, integer_dates)
            + dl_dynamics_map(dyn_map, ppq, integer_dates)
            + dl_rubato_map(rubato, ppq, integer_dates)
            + dl_articulation_map(artic, ppq))


# --------------------------------------------------------------------------- #
# fidelity  (thin wrappers over python/evaluate.py so the numbers are comparable)
# --------------------------------------------------------------------------- #

def render_rmse(tempo_map, rec):
    """Onset RMSE (ms) of the re-rendered map vs the performed onsets.

    Numerically identical to `evaluate.render_rmse`, kept local only so that
    analysis/ does not depend on the arity of the note tuple.  (An earlier revision
    of this docstring claimed evaluate.render_rmse crashes on v2 records; that is
    no longer true -- python/evaluate.py:42 unpacks with a trailing `*_` and handles
    the 6-field v2 notes.  Verified by running it on data/val_v2.jsonl.)
    """
    tl = TempoTimeline(tempo_map)
    se = 0.0
    for n in rec["notes"]:
        e = tl.ms_at(n[0]) - n[3]
        se += e * e
    return math.sqrt(se / len(rec["notes"]))


def render_mae(tempo_map, rec):
    tl = TempoTimeline(tempo_map)
    errs = [abs(tl.ms_at(n[0]) - n[3]) for n in rec["notes"]]
    return sum(errs) / len(errs)


def render_max(tempo_map, rec):
    tl = TempoTimeline(tempo_map)
    return max(abs(tl.ms_at(n[0]) - n[3]) for n in rec["notes"])


def curve_rmse(tempo_map, rec, step=90):
    total = max(n[0] + n[1] for n in rec["notes"])
    return ev.curve_rmse(tempo_map, rec["tempo"], total, step)


def vel_rmse(dyn_map, rec):
    return ev.velocity_render_rmse(dyn_map, rec)


def constant_baseline(rec):
    """Single-instruction tempo map: the cheapest non-trivial explanation."""
    base = ev.constant_baseline(rec)
    base[0][1] = round(base[0][1], 1)     # canonical bpm precision
    return base


# --------------------------------------------------------------------------- #
# two-part MDL
# --------------------------------------------------------------------------- #

def data_bits(n_obs, rmse, resolution=MS_RESOLUTION):
    """Gaussian code length of `n_obs` residuals with RMS `rmse`, quantised at
    `resolution`.  n * [ log2(sigma/delta) + 0.5*log2(2*pi*e) ].  Floored at
    sigma = delta (below the quantiser there is nothing left to pay for)."""
    sigma = max(rmse, resolution)
    return n_obs * (math.log2(sigma / resolution) + 0.5 * math.log2(2 * math.pi * math.e))


def total_bits(dl_tokens, n_obs, rmse, resolution=MS_RESOLUTION):
    """Two-part MDL: model bits + data bits.  Lower is a better explanation."""
    return dl_tokens * BITS_PER_TOKEN + data_bits(n_obs, rmse, resolution)


def mdl_ratio(dl_pred, dl_gt):
    """DL(pred)/DL(GT).  1.0 = as compact as the ground truth; >1 = over-segmented
    (the failure mode a pure render-RMSE metric rewards); <1 = under-segmented."""
    return dl_pred / dl_gt if dl_gt else float("inf")


def score_piece(tempo_map, rec, dyn_map=(), rubato=(), artic=(), integer_dates=True):
    """One row of a Pareto table: DL, fidelity, and the combined bit cost."""
    n = len(rec["notes"])
    dl = dl_piece(tempo_map, dyn_map, rubato, artic, integer_dates=integer_dates)
    r = render_rmse(tempo_map, rec)
    return {
        "dl": dl,
        "n_instr": len(tempo_map),
        "render_rmse": r,
        "render_mae": render_mae(tempo_map, rec),
        "render_max": render_max(tempo_map, rec),
        "n_notes": n,
        "model_bits": dl * BITS_PER_TOKEN,
        "data_bits": data_bits(n, r),
        "total_bits": total_bits(dl, n, r),
    }


# --------------------------------------------------------------------------- #
# self-test: the token counter must agree with dsl.encode_piece exactly
# --------------------------------------------------------------------------- #

def selftest(path=None, limit=None):
    path = path or os.path.join(_HERE, "..", "data", "val_v2.jsonl")
    mismatches = pieces = 0
    worst = 0
    with open(path) as fh:
        for i, line in enumerate(fh):
            if limit and i >= limit:
                break
            rec = json.loads(line)
            t, d = rec["tempo"], rec.get("dynamics", [])
            mine = dl_tempo_map(t) + dl_dynamics_map(d)
            theirs = len(dsl.encode_piece(t, d)) - 2      # minus <bos>/<eos>
            worst = max(worst, abs(mine - theirs))
            mismatches += (mine != theirs)
            pieces += 1
    return pieces, mismatches, worst


if __name__ == "__main__":
    p, m, w = selftest()
    print(f"mdl.py self-test vs dsl.encode_piece: {p} pieces, "
          f"{m} mismatches, max |diff| = {w}")
    sys.exit(1 if m else 0)
