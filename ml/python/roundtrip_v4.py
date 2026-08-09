"""DSL round-trip proof: encode -> decode -> re-render must reproduce the labels exactly.

The v4 DSL (CANONICAL §11) is only a legitimate representation of a piece if putting a
canonical map set through it changes nothing an observer can see. "Nothing" is meant
literally and is checked against the **JSONL's own** millisecond dates, velocities and CC
values -- the numbers the Java fork wrote -- not against a second render of the original
maps, which would only prove the decoder agrees with the encoder.

    for every record:  maps -> encode_piece_v4(subset='full') -> decode_piece_v4 ->
                       PerfChainV4.render() -> compare bit-exactly with the record

Two things are deliberately *not* proven here, because they are not true:

  * ``subset='training'`` round-trips only its four maps (tempo, dynamics, rubato,
    asynchrony). It is the training target, not the representation, so it is checked for
    token-level agreement with the full stream's prefix rather than for render equality.
  * The ``controller`` attribute is outside the frozen 35-token vocabulary; the movement
    production *means* the sustain chain. A record with a soft-pedal chain raises in the
    encoder rather than silently losing it.

Usage: python3 roundtrip_v4.py [pilot.jsonl ...]
"""

import json
import sys

from dsl import (V4_TRAINING_MAPS, _artic_streams, decode_piece_v4, encode_piece_v4)
from perf_chain_v4 import PerfChainV4
from validate_v4 import _bit_identical, _js_round, _record_parts

MAP_KEYS = ("tempo", "dynamics", "rubato", "articulation", "movement", "asynchrony")


def _artic_part_sizes(artic):
    """The per-part row counts the token stream cannot carry (see decode_piece_v4)."""
    return [(part, len(rows)) for part, rows in _artic_streams(artic)]


def roundtrip(path, verbose=False):
    records = [json.loads(line) for line in open(path)]
    n_notes = n_cc = n_tok = 0
    bad = []
    decode_errors = 0
    tokens_full, tokens_train = [], []

    for rec in records:
        rid = rec.get("id")
        maps = {k: rec.get(k) or [] for k in MAP_KEYS}

        ids = encode_piece_v4(maps, subset="full")
        tokens_full.append(len(ids))
        n_tok += len(ids)
        decoded, errors = decode_piece_v4(ids, subset="full",
                                          artic_part_sizes=_artic_part_sizes(maps["articulation"]))
        decode_errors += errors
        if errors:
            bad.append("rec %s: %d decode errors" % (rid, errors))

        # the training subset must be the full stream's own tokens for its four maps, so that
        # a model trained on it is learning a prefix of the representation, not a dialect
        train_ids = encode_piece_v4(maps, subset="training")
        tokens_train.append(len(train_ids))
        expect = encode_piece_v4({k: (maps[k] if k in V4_TRAINING_MAPS else [])
                                  for k in MAP_KEYS}, subset="full")
        if train_ids != expect:
            bad.append("rec %s: training subset is not the full grammar's own tokens" % rid)

        _g0, _s0, refs, _keys, _raw = _record_parts(rec)
        rec2 = dict(rec)
        rec2.update(decoded)
        gmaps, specs, _r1, _k1, _raw1 = _record_parts(rec2)
        chain = PerfChainV4(specs, global_maps=gmaps,
                            movement_sample_max_step=rec.get("movementSampleMaxStep"))
        got_parts = chain.render()

        for pp, ref in zip(got_parts, refs):
            if len(pp.notes) != len(ref["notes"]):
                bad.append("rec %s part %s: %d notes vs %d reference"
                           % (rid, pp.number, len(pp.notes), len(ref["notes"])))
                continue
            for i, (g, e) in enumerate(zip(pp.notes, ref["notes"])):
                n_notes += 1
                for field, got, want in (("ms_on", g.ms_on, e["ms_on"]),
                                         ("ms_off", g.ms_off, e["ms_off"]),
                                         ("velocity", g.velocity, e["velocity"])):
                    if want is None:
                        continue
                    if not _bit_identical(got, want):
                        bad.append("rec %s/p%s/n%d %s: %r != %r"
                                   % (rid, pp.number, i, field, got, want))
            for selector, rows in ref["cc"]:
                if selector is None:
                    got = (pp.positions if len(rows) == len(pp.positions)
                           else pp.volumes + pp.positions)
                else:
                    stream = pp.stream(*selector)
                    got = stream.points if stream is not None else []
                if len(got) != len(rows):
                    bad.append("rec %s/p%s cc: %d points vs %d reference"
                               % (rid, pp.number, len(got), len(rows)))
                    continue
                # the ground truth is the MIDI observable round(value), as it is everywhere
                # else in this program -- an exact comparison of a value the port computes.
                for i, (g, e) in enumerate(zip(got, rows)):
                    n_cc += 1
                    if not _bit_identical(g.ms, e["ms"]):
                        bad.append("rec %s/p%s/cc%d ms: %r != %r"
                                   % (rid, pp.number, i, g.ms, e["ms"]))
                    if not _bit_identical(float(_js_round(g.value)), float(e["value"])):
                        bad.append("rec %s/p%s/cc%d value: %r != %r"
                                   % (rid, pp.number, i, g.value, e["value"]))

    def q(a, p):
        return sorted(a)[int((len(a) - 1) * p)] if a else 0

    print("round-trip %s: %d records, %d notes, %d cc points compared bit-exactly"
          % (path, len(records), n_notes, n_cc))
    print("  tokens/piece  full grammar: median %d p90 %d max %d (total %d)"
          % (q(tokens_full, 0.5), q(tokens_full, 0.9), max(tokens_full), n_tok))
    print("  tokens/piece  training subset (%s): median %d p90 %d max %d"
          % ("+".join(V4_TRAINING_MAPS), q(tokens_train, 0.5), q(tokens_train, 0.9),
             max(tokens_train)))
    print("  decode errors: %d" % decode_errors)
    if bad:
        for line in bad[:20] if not verbose else bad:
            print("  FAIL %s" % line)
        print("  ... %d more" % (len(bad) - 20) if len(bad) > 20 and not verbose else "")
        print("ROUNDTRIP_FAIL (%d mismatches)" % len(bad))
        return 1
    print("ROUNDTRIP_EXACT")
    return 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    paths = args or ["../data/pilot_v4.jsonl"]
    rc = 0
    for p in paths:
        rc |= roundtrip(p, verbose=verbose)
    sys.exit(rc)
