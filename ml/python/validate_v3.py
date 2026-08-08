"""Validate v3 generated JSONL (tempo + dynamics + articulation + rubato).

Recomputes every note's millisecond onset, millisecond offset and MIDI velocity from the
sampled MPM maps with the pure-Python port (``perf_chain.PerfChain``) and compares against
the values meico actually rendered.

The project's standard of proof is exact reproduction, so this reports not only the max
abs diff but also the number of values that are not *bit-identical* doubles and the max
distance in ulp. All three must be zero for the "EXACT" verdict. (A 1-ulp diff shows up
as 0.000000000 ms in a %.9f report but is not exact -- that is precisely how the fdlibm
pow/log divergence between Java and the platform libm was found.)

"Bit-identical" is tested on the raw IEEE-754 64-bit pattern, not with ``==``: ``==``
also equates ``+0.0`` and ``-0.0``, which are distinguishable doubles that meico can
emit (``Double.toString`` writes "-0.0"), so a sign-of-zero divergence would otherwise be
reported as 0 ulp.

Coverage counters are printed too, so the verdict cannot be passed by data that does not
exercise articulation/rubato at all. They include the counters PerfChain fills in for the
order-dependent meico code paths (pendingDurations break vs continue, stacked
articulations); a zero there means that path is *not* under test by this dataset.

The four ``pilot_v3_cov_*`` datasets are generated with the sampler's deliberately
NON-CANONICAL port-coverage switches and exist to drive those counters off zero:
``cov_polyphony`` (overlapping notes -> pendingDurations break vs continue),
``cov_stackedArtic`` (several articulations per date), ``cov_danglingTempo`` (final
transition -> endDate == Double.MAX_VALUE as a divisor), ``cov_lateStart``
(lateStart/earlyEnd != 0/1). They are validation data, never training data.

Usage: python3 validate_v3.py [../data/pilot_v3.jsonl] [--verbose]
       python3 validate_v3.py --selftest     # fdlibm port vs embedded Java bit patterns
"""

import json
import math
import struct
import sys

from perf_chain import PerfChain
from rubato_math import RUB_INTENSITY, RubatoTimeline

STAT_KEYS = ("rubato_pending_break", "rubato_pending_blocked", "tempo_pending_skipped",
             "tempo_pending_revisited", "stacked_articulations")


def _bitpattern(x):
    return struct.unpack("<Q", struct.pack("<d", x))[0]


def _bit_identical(a, b):
    """True iff a and b are the same double bit for bit (NaN payloads included)."""
    return _bitpattern(a) == _bitpattern(b)


def _ulps(a, b):
    if _bit_identical(a, b):
        return 0.0
    if math.isnan(a) or math.isnan(b) or math.isinf(a) or math.isinf(b):
        return float("inf")
    if a == b:                                  # +0.0 vs -0.0: differ in bits, not in value
        return 0.0
    return abs(a - b) / math.ulp(max(abs(a), abs(b), 5e-324))


# ---------------------------------------------------------------------------------------
# Java-free regression vectors for the fdlibm port in ``rubato_math``.
#
# "xbits,ybits,Math.pow(x,y)bits,Math.log(x)bits", raw IEEE-754 hex, produced by Java
# (Zulu 17, aarch64) -- see the reproduction command in the module docstring of
# ``rubato_math``. The selection is the corner grid (+-0, +-1, +-inf, NaN, subnormals,
# Double.MAX_VALUE crossed with negative / huge / non-integral exponents) plus eight cases
# whose ``pow`` result is subnormal (four of them chosen because ``math.ldexp`` gets them
# wrong) and one negative-signed NaN. Each of the three defects the port has actually had is
# covered here:
#   * ``java_pow(+-0.0, y<0)`` used to raise ZeroDivisionError instead of returning +-inf;
#   * the subnormal branch used ``math.ldexp``, which is not correctly rounded on macOS;
#   * ``java_log`` of a negative-signed NaN dropped the NaN payload.
# Run with ``python3 validate_v3.py --selftest``.
_LIBM_VECTORS = (
    "0000000000000000,bff0000000000000,7ff0000000000000,fff0000000000000 0000000000000000,4000000000000000,0000000000000000,fff0000000000000 "
    "0000000000000000,c000000000000000,7ff0000000000000,fff0000000000000 0000000000000000,3fe0000000000000,0000000000000000,fff0000000000000 "
    "0000000000000000,bfe0000000000000,7ff0000000000000,fff0000000000000 0000000000000000,c008000000000000,7ff0000000000000,fff0000000000000 "
    "0000000000000000,c090cc0000000000,7ff0000000000000,fff0000000000000 0000000000000000,43abc16d674ec800,0000000000000000,fff0000000000000 "
    "0000000000000000,c3abc16d674ec800,7ff0000000000000,fff0000000000000 0000000000000000,fe37e43c8800759c,7ff0000000000000,fff0000000000000 "
    "0000000000000000,7ff0000000000000,0000000000000000,fff0000000000000 0000000000000000,fff0000000000000,7ff0000000000000,fff0000000000000 "
    "0000000000000000,7ff8000000000000,7ff8000000000000,fff0000000000000 8000000000000000,bff0000000000000,fff0000000000000,fff0000000000000 "
    "8000000000000000,4000000000000000,0000000000000000,fff0000000000000 8000000000000000,c000000000000000,7ff0000000000000,fff0000000000000 "
    "8000000000000000,3fe0000000000000,0000000000000000,fff0000000000000 8000000000000000,bfe0000000000000,7ff0000000000000,fff0000000000000 "
    "8000000000000000,c008000000000000,fff0000000000000,fff0000000000000 8000000000000000,c090cc0000000000,fff0000000000000,fff0000000000000 "
    "8000000000000000,43abc16d674ec800,0000000000000000,fff0000000000000 8000000000000000,c3abc16d674ec800,7ff0000000000000,fff0000000000000 "
    "8000000000000000,fe37e43c8800759c,7ff0000000000000,fff0000000000000 8000000000000000,7ff0000000000000,0000000000000000,fff0000000000000 "
    "8000000000000000,fff0000000000000,7ff0000000000000,fff0000000000000 8000000000000000,7ff8000000000000,7ff8000000000000,fff0000000000000 "
    "3ff0000000000000,bff0000000000000,3ff0000000000000,0000000000000000 3ff0000000000000,4000000000000000,3ff0000000000000,0000000000000000 "
    "3ff0000000000000,c000000000000000,3ff0000000000000,0000000000000000 3ff0000000000000,3fe0000000000000,3ff0000000000000,0000000000000000 "
    "3ff0000000000000,bfe0000000000000,3ff0000000000000,0000000000000000 3ff0000000000000,c008000000000000,3ff0000000000000,0000000000000000 "
    "3ff0000000000000,c090cc0000000000,3ff0000000000000,0000000000000000 3ff0000000000000,43abc16d674ec800,3ff0000000000000,0000000000000000 "
    "3ff0000000000000,c3abc16d674ec800,3ff0000000000000,0000000000000000 3ff0000000000000,fe37e43c8800759c,3ff0000000000000,0000000000000000 "
    "3ff0000000000000,7ff0000000000000,7ff8000000000000,0000000000000000 3ff0000000000000,fff0000000000000,7ff8000000000000,0000000000000000 "
    "3ff0000000000000,7ff8000000000000,7ff8000000000000,0000000000000000 bff0000000000000,bff0000000000000,bff0000000000000,7ff8000000000000 "
    "bff0000000000000,4000000000000000,3ff0000000000000,7ff8000000000000 bff0000000000000,c000000000000000,3ff0000000000000,7ff8000000000000 "
    "bff0000000000000,3fe0000000000000,7ff8000000000000,7ff8000000000000 bff0000000000000,bfe0000000000000,7ff8000000000000,7ff8000000000000 "
    "bff0000000000000,c008000000000000,bff0000000000000,7ff8000000000000 bff0000000000000,c090cc0000000000,bff0000000000000,7ff8000000000000 "
    "bff0000000000000,43abc16d674ec800,3ff0000000000000,7ff8000000000000 bff0000000000000,c3abc16d674ec800,3ff0000000000000,7ff8000000000000 "
    "bff0000000000000,fe37e43c8800759c,3ff0000000000000,7ff8000000000000 bff0000000000000,7ff0000000000000,7ff8000000000000,7ff8000000000000 "
    "bff0000000000000,fff0000000000000,7ff8000000000000,7ff8000000000000 bff0000000000000,7ff8000000000000,7ff8000000000000,7ff8000000000000 "
    "0000000000000001,bff0000000000000,7ff0000000000000,c0874385446d71c3 0000000000000001,4000000000000000,0000000000000000,c0874385446d71c3 "
    "0000000000000001,c000000000000000,7ff0000000000000,c0874385446d71c3 0000000000000001,3fe0000000000000,1e60000000000000,c0874385446d71c3 "
    "0000000000000001,bfe0000000000000,6180000000000000,c0874385446d71c3 0000000000000001,c008000000000000,7ff0000000000000,c0874385446d71c3 "
    "0000000000000001,c090cc0000000000,7ff0000000000000,c0874385446d71c3 0000000000000001,43abc16d674ec800,0000000000000000,c0874385446d71c3 "
    "0000000000000001,c3abc16d674ec800,7ff0000000000000,c0874385446d71c3 0000000000000001,fe37e43c8800759c,7ff0000000000000,c0874385446d71c3 "
    "0000000000000001,7ff0000000000000,0000000000000000,c0874385446d71c3 0000000000000001,fff0000000000000,7ff0000000000000,c0874385446d71c3 "
    "0000000000000001,7ff8000000000000,7ff8000000000000,c0874385446d71c3 8000000000000001,bff0000000000000,fff0000000000000,7ff8000000000000 "
    "8000000000000001,4000000000000000,0000000000000000,7ff8000000000000 8000000000000001,c000000000000000,7ff0000000000000,7ff8000000000000 "
    "8000000000000001,3fe0000000000000,7ff8000000000000,7ff8000000000000 8000000000000001,bfe0000000000000,7ff8000000000000,7ff8000000000000 "
    "8000000000000001,c008000000000000,fff0000000000000,7ff8000000000000 8000000000000001,c090cc0000000000,fff0000000000000,7ff8000000000000 "
    "8000000000000001,43abc16d674ec800,0000000000000000,7ff8000000000000 8000000000000001,c3abc16d674ec800,7ff0000000000000,7ff8000000000000 "
    "8000000000000001,fe37e43c8800759c,7ff0000000000000,7ff8000000000000 8000000000000001,7ff0000000000000,0000000000000000,7ff8000000000000 "
    "8000000000000001,fff0000000000000,7ff0000000000000,7ff8000000000000 8000000000000001,7ff8000000000000,7ff8000000000000,7ff8000000000000 "
    "7fefffffffffffff,bff0000000000000,0004000000000000,40862e42fefa39ef 7fefffffffffffff,4000000000000000,7ff0000000000000,40862e42fefa39ef "
    "7fefffffffffffff,c000000000000000,0000000000000000,40862e42fefa39ef 7fefffffffffffff,3fe0000000000000,5fefffffffffffff,40862e42fefa39ef "
    "7fefffffffffffff,bfe0000000000000,1ff0000000000000,40862e42fefa39ef 7fefffffffffffff,c008000000000000,0000000000000000,40862e42fefa39ef "
    "7fefffffffffffff,c090cc0000000000,0000000000000000,40862e42fefa39ef 7fefffffffffffff,43abc16d674ec800,7ff0000000000000,40862e42fefa39ef "
    "7fefffffffffffff,c3abc16d674ec800,0000000000000000,40862e42fefa39ef 7fefffffffffffff,fe37e43c8800759c,0000000000000000,40862e42fefa39ef "
    "7fefffffffffffff,7ff0000000000000,7ff0000000000000,40862e42fefa39ef 7fefffffffffffff,fff0000000000000,0000000000000000,40862e42fefa39ef "
    "7fefffffffffffff,7ff8000000000000,7ff8000000000000,40862e42fefa39ef 7ff0000000000000,bff0000000000000,0000000000000000,7ff0000000000000 "
    "7ff0000000000000,4000000000000000,7ff0000000000000,7ff0000000000000 7ff0000000000000,c000000000000000,0000000000000000,7ff0000000000000 "
    "7ff0000000000000,3fe0000000000000,7ff0000000000000,7ff0000000000000 7ff0000000000000,bfe0000000000000,0000000000000000,7ff0000000000000 "
    "7ff0000000000000,c008000000000000,0000000000000000,7ff0000000000000 7ff0000000000000,c090cc0000000000,0000000000000000,7ff0000000000000 "
    "7ff0000000000000,43abc16d674ec800,7ff0000000000000,7ff0000000000000 7ff0000000000000,c3abc16d674ec800,0000000000000000,7ff0000000000000 "
    "7ff0000000000000,fe37e43c8800759c,0000000000000000,7ff0000000000000 7ff0000000000000,7ff0000000000000,7ff0000000000000,7ff0000000000000 "
    "7ff0000000000000,fff0000000000000,0000000000000000,7ff0000000000000 7ff0000000000000,7ff8000000000000,7ff8000000000000,7ff0000000000000 "
    "fff0000000000000,bff0000000000000,8000000000000000,7ff8000000000000 fff0000000000000,4000000000000000,7ff0000000000000,7ff8000000000000 "
    "fff0000000000000,c000000000000000,0000000000000000,7ff8000000000000 fff0000000000000,3fe0000000000000,7ff0000000000000,7ff8000000000000 "
    "fff0000000000000,bfe0000000000000,0000000000000000,7ff8000000000000 fff0000000000000,c008000000000000,8000000000000000,7ff8000000000000 "
    "fff0000000000000,c090cc0000000000,8000000000000000,7ff8000000000000 fff0000000000000,43abc16d674ec800,7ff0000000000000,7ff8000000000000 "
    "fff0000000000000,c3abc16d674ec800,0000000000000000,7ff8000000000000 fff0000000000000,fe37e43c8800759c,0000000000000000,7ff8000000000000 "
    "fff0000000000000,7ff0000000000000,7ff0000000000000,7ff8000000000000 fff0000000000000,fff0000000000000,0000000000000000,7ff8000000000000 "
    "fff0000000000000,7ff8000000000000,7ff8000000000000,7ff8000000000000 7ff8000000000000,bff0000000000000,7ff8000000000000,7ff8000000000000 "
    "7ff8000000000000,4000000000000000,7ff8000000000000,7ff8000000000000 7ff8000000000000,c000000000000000,7ff8000000000000,7ff8000000000000 "
    "7ff8000000000000,3fe0000000000000,7ff8000000000000,7ff8000000000000 7ff8000000000000,bfe0000000000000,7ff8000000000000,7ff8000000000000 "
    "7ff8000000000000,c008000000000000,7ff8000000000000,7ff8000000000000 7ff8000000000000,c090cc0000000000,7ff8000000000000,7ff8000000000000 "
    "7ff8000000000000,43abc16d674ec800,7ff8000000000000,7ff8000000000000 7ff8000000000000,c3abc16d674ec800,7ff8000000000000,7ff8000000000000 "
    "7ff8000000000000,fe37e43c8800759c,7ff8000000000000,7ff8000000000000 7ff8000000000000,7ff0000000000000,7ff8000000000000,7ff8000000000000 "
    "7ff8000000000000,fff0000000000000,7ff8000000000000,7ff8000000000000 7ff8000000000000,7ff8000000000000,7ff8000000000000,7ff8000000000000 "
    "5cb777bd4e6551a0,c00276b23d3f4af0,000000000000085d,4073f3b11d2e97fc 6e90e31a78d7b9f4,bff69336e22d4b28,0000000000282c55,4080292252b7ecf0 "
    "2e51d1f886e5ce61,400dd619364a3420,0000000000734f3b,c0686b8329ab7aa4 62079e56aa5c97b6,bfff56983209ad58,000000000000002b,4077a27977f25f34 "
    "10aea0ff0680d022,3ff5b1e4d9b2ebe0,0001c7361894cfdb,c080608125f52e7b "
    "2ac0e09acb47d598,40082e3289797c74,00030079b36bd72d,c06d5d8d644a7a8c "
    "135347dd53487a40,3ff70012fc429cc0,0000ffcd98483af7,c07eeb87745e5e3d "
    "53d0a758d9ba0f85,c009c473bfe49984,0002f2e418933363,406b8ebf426008e0 "
    "ffff1b5ef1e98692,bf9208bee5aa3000,ffff1b5ef1e98692,ffff1b5ef1e98692 "
)


def selftest():
    """Check the fdlibm port against the embedded Java bit patterns. No Java needed."""
    from rubato_math import java_log, java_pow
    cases = [c.split(",") for line in _LIBM_VECTORS.split() for c in [line]]
    bad = crash = 0
    for xh, yh, ph, lh in cases:
        x = struct.unpack("<d", struct.pack("<Q", int(xh, 16)))[0]
        y = struct.unpack("<d", struct.pack("<Q", int(yh, 16)))[0]
        for fn, args, want in ((java_pow, (x, y), int(ph, 16)),
                               (java_log, (x,), int(lh, 16))):
            try:
                got = _bitpattern(fn(*args))
            except Exception as e:                                  # noqa: BLE001
                print(f"  CRASH {fn.__name__}{args}: {type(e).__name__}: {e}")
                crash += 1
                continue
            if got != want:
                bad += 1
                print(f"  MISMATCH {fn.__name__}{args}: got {got:#018x} want {want:#018x}")
    print(f"fdlibm selftest: {len(cases)} vectors, {2 * len(cases)} calls, "
          f"{bad} mismatches, {crash} crashes")
    return 0 if (bad == 0 and crash == 0) else 1


def main(path, verbose=False):
    max_abs = {"on": 0.0, "off": 0.0, "vel": 0.0}
    max_ulp = {"on": 0.0, "off": 0.0, "vel": 0.0}
    n_neq = {"on": 0, "off": 0, "vel": 0}
    worst = {"on": None, "off": None, "vel": None}

    n_notes = n_pieces = n_nonfinite = 0
    n_art = n_art_notes = 0
    n_rub = n_rub_spans = n_rub_pieces = n_warped_notes = 0
    n_dyn = n_tempo = 0
    n_dangling_tempo = n_overlap = 0
    stats = {k: 0 for k in STAT_KEYS}

    for line in open(path):
        rec = json.loads(line)
        tempo = rec.get("tempo")
        artic = rec.get("articulation") or []
        rub = rec.get("rubato") or []

        chain = PerfChain(tempo=tempo, dynamics=rec.get("dynamics"),
                          articulation=artic, rubato=rub)
        rendered = chain.render([(n[0], n[1]) for n in rec["notes"]])
        for k in STAT_KEYS:
            stats[k] += chain.stats.get(k, 0)
        if tempo and tempo[-1][2] is not None:              # dangling final transition (not G7)
            n_dangling_tempo += 1
        notes_in = rec["notes"]
        n_overlap += sum(1 for i in range(1, len(notes_in))
                         if notes_in[i - 1][0] + notes_in[i - 1][1] > notes_in[i][0]
                         + notes_in[i][1])                  # non-monotone end dates

        art_dates = {a[0] for a in artic}
        rt = RubatoTimeline(rub) if rub else None

        for note, ref in zip(rendered, rec["notes"]):
            got = {"on": note.ms_on, "off": note.ms_off, "vel": note.velocity}
            exp = {"on": ref[3], "off": ref[4], "vel": ref[5]}
            for k in ("on", "off", "vel"):
                g, e = got[k], exp[k]
                if g is None or (g != g):
                    n_nonfinite += 1
                    n_neq[k] += 1
                    max_abs[k] = float("inf")
                    max_ulp[k] = float("inf")
                    worst[k] = (rec["id"], ref, note)
                    continue
                if not _bit_identical(g, e):                # raw IEEE-754 pattern, not ==
                    n_neq[k] += 1
                    d = abs(g - e)
                    if d >= max_abs[k]:
                        max_abs[k] = d
                        worst[k] = (rec["id"], ref, note)
                    max_ulp[k] = max(max_ulp[k], _ulps(g, e))
            n_notes += 1
            if ref[0] in art_dates:
                n_art_notes += 1
            if rt is not None:
                i = rt.instr_index_for_date(ref[0])
                # a *span* is an instruction with a non-identity intensity; R6 terminators
                # carry intensity 1 (and, since R6, loop=true as well, so the loop flag can
                # no longer be used to tell the two apart)
                if i is not None and rt.instrs[i][RUB_INTENSITY] != 1.0:
                    n_warped_notes += 1

        n_pieces += 1
        n_art += len(artic)
        n_rub += len(rub)
        spans = sum(1 for r in rub if r[RUB_INTENSITY] != 1.0)
        n_rub_spans += spans
        n_rub_pieces += 1 if spans else 0
        n_dyn += len(rec.get("dynamics") or [])
        n_tempo += len(tempo or [])

    print(f"{n_pieces} pieces, {n_notes} notes")
    print(f"  tempo instructions      : {n_tempo}")
    print(f"  dynamics instructions   : {n_dyn}")
    print(f"  articulation instr.     : {n_art}  (affecting {n_art_notes} notes)")
    print(f"  rubato spans            : {n_rub_spans} in {n_rub_pieces} pieces "
          f"(+{n_rub - n_rub_spans} terminators; {n_warped_notes} notes inside spans)")
    print(f"  non-monotone note ends  : {n_overlap}   dangling final tempo transitions: "
          f"{n_dangling_tempo}")
    print("  meico order-dependent paths exercised: "
          + "  ".join(f"{k}={stats[k]}" for k in STAT_KEYS))
    for k, label in (("on", "onset ms  "), ("off", "offset ms "), ("vel", "velocity  ")):
        print(f"  {label} max|diff| = {max_abs[k]:.9f}   max ulp = {max_ulp[k]:.1f}   "
              f"non-bit-identical = {n_neq[k]} / {n_notes}")
    if n_nonfinite:
        print(f"  NaN/None values: {n_nonfinite}")

    if verbose:
        for k in ("on", "off", "vel"):
            if worst[k] is not None:
                piece, ref, note = worst[k]
                print(f"worst {k}: piece {piece} ref={ref} got={note}")

    ok = (sum(n_neq.values()) == 0) and (n_nonfinite == 0) and n_notes > 0
    print("EXACT" if ok else "MISMATCH")
    return 0 if ok else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv[1:]:
        sys.exit(selftest())
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    sys.exit(main(args[0] if args else "../data/pilot_v3.jsonl",
                  "--verbose" in sys.argv[1:]))
