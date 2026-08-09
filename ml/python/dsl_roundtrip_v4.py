"""v4 DSL round-trip gate: JSONL -> tokens -> maps -> render, bit-compared with the JSONL.

    python3 dsl_roundtrip_v4.py ../data/pilot_v4.jsonl [--subset full|training] [--limit N]

This is the project's standard acceptance bar for a DSL change, not a spot check. It asserts
two things about `dsl.encode_piece_v4` / `dsl.decode_piece_v4`:

1. **Map fidelity** -- every decoded map equals the record's own map, field for field, at
   full double precision. Movement is the interesting one: §11 encodes positions as integer
   CC values and dates as 1/4-beat deltas, so the decoded row is a *reconstruction*, and
   `k/127` has to come back as the very same double the renderer was given.
2. **Render fidelity** -- the decoded maps, pushed through `PerfChainV4`, reproduce the
   JSONL's own `milliseconds.date`, `milliseconds.date.end`, `velocity` and `sustain_cc`
   **bit-exactly**. This is the bar `validate_v4.py` clears for the maps as written; here it
   is the maps as they survive a trip through the token vocabulary.

The `--subset training` run is not an acceptance bar -- articulation and movement are absent
from that target by construction, so the render cannot match. It reports the token budget
(the number that sets `MAX_DECODE`) and checks that the four maps it *does* carry survive.
"""

import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dsl import V4_MAP_ORDER, decode_piece_v4, encode_piece_v4  # noqa: E402
from perf_chain_v4 import PerfChainV4  # noqa: E402
# `_js_round` and not Python's `round`: the JSONL records `Math.round(value)`, which differs
# from banker's rounding on every exact .5 -- and CC values land on .5 often enough to fail
# two points per piece, which is exactly how this was found.
from validate_v4 import _js_round, _record_parts  # noqa: E402,PLC2701

MAP_FIELD_NAMES = {
    "tempo": ("date", "bpm", "transition.to", "meanTempoAt"),
    "dynamics": ("date", "volume", "transition.to", "curvature", "protraction"),
    "rubato": ("date", "frameLength", "intensity", "lateStart", "earlyEnd", "loop"),
    "articulation": ("date", "relativeDuration", "velocityChange", "part"),
    "movement": ("date", "position", "transition.to", "curvature", "protraction",
                 "controller"),
    "asynchrony": ("date", "milliseconds.offset"),
}


def _artic_part_sizes(rows):
    """``[(part, n), ...]`` in part order -- the split the token stream cannot carry."""
    sizes = {}
    for row in rows or []:
        part = row[3] if len(row) > 3 else 1
        sizes[part] = sizes.get(part, 0) + 1
    return [(p, sizes[p]) for p in sorted(sizes)]


def _same_number(a, b):
    """Bit equality for the map fields, with None matched only by None."""
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, str) or isinstance(b, str):
        return a == b
    return float(a) == float(b)


def _diff_maps(name, got, want):
    """Field-level differences between a decoded map and the record's own."""
    out = []
    if len(got) != len(want):
        out.append(f"{name}: {len(got)} rows decoded, {len(want)} in the record")
        return out
    fields = MAP_FIELD_NAMES[name]
    for i, (g, w) in enumerate(zip(got, want)):
        for j in range(max(len(g), len(w))):
            gv = g[j] if j < len(g) else None
            wv = w[j] if j < len(w) else None
            if not _same_number(gv, wv):
                label = fields[j] if j < len(fields) else f"[{j}]"
                out.append(f"{name}[{i}].{label}: decoded {gv!r} != record {wv!r}")
    return out


def _render(rec):
    """(notes, sustain_cc points) for one record, through PerfChainV4."""
    gmaps, specs, _refs, _keys, _raw = _record_parts(rec)
    chain = PerfChainV4(specs, global_maps=gmaps,
                        movement_sample_max_step=rec.get("movementSampleMaxStep"))
    parts = chain.render()
    notes = [(n.part, n.date, n.ms_on, n.ms_off, n.velocity)
             for p in parts for n in p.notes]
    stream = parts[0].stream(kind="position", controller="sustain") if parts else None
    cc = [(p.ms, _js_round(p.value)) for p in stream.points] if stream else []
    return notes, cc


def main(argv):
    path = argv[0]
    subset = "full"
    limit = None
    for i, a in enumerate(argv[1:], 1):
        if a == "--subset":
            subset = argv[i + 1]
        elif a == "--limit":
            limit = int(argv[i + 1])
    records = [json.loads(line) for line in open(path)]
    if limit:
        records = records[:limit]

    lens, map_bad, render_bad, examples = [], 0, 0, []
    n_notes = n_cc = 0
    fields_compared = 0
    for rec in records:
        maps = {k: rec.get(k) or [] for k in V4_MAP_ORDER}
        ids = encode_piece_v4(maps, subset=subset)
        lens.append(len(ids))
        got, errors = decode_piece_v4(ids, subset=subset,
                                      artic_part_sizes=_artic_part_sizes(maps["articulation"]))
        problems = [f"{errors} parse error(s)"] if errors else []
        for name in V4_MAP_ORDER:
            if subset == "training" and name in ("articulation", "movement"):
                continue
            problems += _diff_maps(name, got[name], maps[name])
            fields_compared += sum(len(r) for r in maps[name])
        if problems:
            map_bad += 1
            if len(examples) < 5:
                examples.append(f"piece {rec.get('id')}: " + "; ".join(problems[:4]))
            continue
        if subset != "full":
            continue

        redecoded = dict(rec)
        redecoded.update(got)
        got_notes, got_cc = _render(redecoded)
        # The comparison is against the FILE, not against a second render of the same maps:
        # the JSONL row is the ground truth, and a re-render on both sides would cancel any
        # error the chain and the DSL happened to share.
        want_notes = [(n[6] if len(n) > 6 else 1, n[0], n[3], n[4], n[5])
                      for n in rec["notes"]]
        want_cc = [(ms, float(value)) for ms, value in (rec.get("sustain_cc") or [])]
        n_notes += len(want_notes)
        n_cc += len(want_cc)
        bad = []
        if len(want_notes) != len(got_notes):
            bad.append(f"{len(got_notes)} notes rendered, {len(want_notes)} in the record")
        else:
            n_off = sum(1 for a, b in zip(want_notes, got_notes) if a != b)
            if n_off:
                first = next(f"part{b[0]}@{b[1]}: {b[2:]} != {a[2:]}"
                             for a, b in zip(want_notes, got_notes) if a != b)
                bad.append(f"{n_off} note(s) differ from the JSONL ms/velocity ({first})")
        if want_cc != got_cc:
            n_off = sum(1 for a, b in zip(want_cc, got_cc) if a != b)
            bad.append(f"{n_off} cc point(s) differ from the JSONL sustain_cc "
                       f"({len(want_cc)} recorded vs {len(got_cc)} rendered)")
        if bad:
            render_bad += 1
            if len(examples) < 5:
                examples.append(f"piece {rec.get('id')}: " + "; ".join(bad[:3]))

    print(f"{path}: {len(records)} records, subset={subset}")
    print(f"  target tokens        median {statistics.median(lens):.0f}  "
          f"p90 {sorted(lens)[int(0.9 * (len(lens) - 1))]}  max {max(lens)}  "
          f"min {min(lens)}")
    print(f"  map round-trip       {len(records) - map_bad}/{len(records)} exact "
          f"({fields_compared} map fields compared)")
    if subset == "full":
        print(f"  render round-trip    {len(records) - map_bad - render_bad}/{len(records)} "
              f"bit-exact vs the JSONL ({n_notes} notes, {n_cc} cc points)")
    for e in examples:
        print(f"  FAIL {e}")
    ok = map_bad == 0 and (subset != "full" or render_bad == 0)
    print("DSL_ROUNDTRIP_PASS" if ok else "DSL_ROUNDTRIP_FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
