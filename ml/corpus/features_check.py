#!/usr/bin/env python3
"""Step 5c: run the corpus through the training-side feature and label extractors.

    nice -n 15 python3 features_check.py ../data/corpus_pilot_v4.jsonl [--dsl]

This is the acceptance gate the deliverable names: a features/labels pass through
``dataset.piece_to_features_v41`` with **0 non-finite**. It matters more here than on
synthetic data, because every one of the v3.1/v4 features is a *ratio* or a *log* over
neighbouring notes, and real repertoire supplies the degenerate cases a sampler never does —
a single-note window, a part that plays one chord and stops, two notes at the same score date
in the same part, a piece whose first onset is not at tick 0.

What is checked, per record and per feature column:

* every value finite (the gate);
* the observed range, printed per era, so a feature that is silently constant on real data —
  which is how a conditioning feature stops conditioning anything — is visible rather than
  merely finite;
* the note-label arrays (`artic_present`, `relative_duration`, `velocity_change`,
  `pedal_state`) align row-for-row with the feature rows, which is the invariant the per-note
  heads rest on;
* with ``--dsl``, the v4 DSL round-trip: encode the record's maps, decode them back, and
  require the decoded maps to equal the originals. That is a statement about the *corpus*
  rather than about the encoder: real-repertoire maps reach longer dates and finer bar grids
  than the synthetic set, and a date that does not survive the digit tokeniser would be a
  label the decoder can never emit.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python"))

import dataset  # noqa: E402  (path juggling above is deliberate)

def _diff(want, got):
    """`[(row, col, |delta|)]` for every scalar that differs; a shape mismatch is one entry."""
    if len(want) != len(got):
        return [(-1, -1, float("inf"))]
    out = []
    for i, (a, b) in enumerate(zip(want, got)):
        if len(a) != len(b):
            out.append((i, -1, float("inf")))
            continue
        for j, (x, y) in enumerate(zip(a, b)):
            if isinstance(x, float) and isinstance(y, float):
                if x != y:
                    out.append((i, j, abs(x - y)))
            elif x != y:
                out.append((i, j, float("inf")))
    return out


def _norm(rows):
    """Map rows as nested floats, so `0` and `0.0` compare equal.

    `None` stays `None` and a string (the movement row's `controller`) stays a string; only
    numbers are coerced, which is the whole point — the DSL is digit-tokenised, so a date that
    went in as `0` comes back as `0.0`, and comparing JSON text would call that a failure.
    """
    return [[float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v for v in row] for row in rows]


FEATURE_NAMES = [
    "onset_beats/100",
    "duration_beats",
    "perf_onset_s/60",
    "perf_duration_s",
    "ioi_beats",
    "ioi_s",
    "local_log2_bpm/4",
    "is_chord_tone",
    "pos_frac",
    "velocity/127",
    "log2_dur_ratio",
    "onset_residual",
    "velocity_spike",
    "part",
    "pedal_state",
    "cross_part_offset",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("jsonl")
    ap.add_argument("--dsl", action="store_true", help="also check the v4 DSL round-trip")
    a = ap.parse_args()

    recs = [json.loads(l) for l in open(a.jsonl) if l.strip()]
    n_expect = dataset.N_FEATURES_V41

    total_rows = 0
    nonfinite = 0
    bad_records = []
    per_era_min = defaultdict(lambda: [math.inf] * n_expect)
    per_era_max = defaultdict(lambda: [-math.inf] * n_expect)
    per_era_rows = defaultdict(int)
    label_rows = 0
    label_nonfinite = 0

    for rec in recs:
        era = rec.get("era", "?")
        rows = dataset.piece_to_features_v41(rec)
        if len(rows) != len(rec["notes"]):
            bad_records.append((rec.get("piece_id"), rec.get("window"), f"{len(rows)} feature rows for {len(rec['notes'])} notes"))
        for row in rows:
            if len(row) != n_expect:
                bad_records.append((rec.get("piece_id"), rec.get("window"), f"row width {len(row)} != {n_expect}"))
                break
            total_rows += 1
            per_era_rows[era] += 1
            for i, v in enumerate(row):
                if not math.isfinite(v):
                    nonfinite += 1
                    if len(bad_records) < 20:
                        bad_records.append((rec.get("piece_id"), rec.get("window"), f"non-finite in {FEATURE_NAMES[i]}"))
                else:
                    if v < per_era_min[era][i]:
                        per_era_min[era][i] = v
                    if v > per_era_max[era][i]:
                        per_era_max[era][i] = v

        labels = dataset.piece_to_note_labels_v4(rec)
        # The label block is a dict of equal-length arrays, one entry per note, in the same
        # order as the feature rows; the heads index them together.
        lens = {k: len(v) for k, v in labels.items()} if isinstance(labels, dict) else {"labels": len(labels)}
        for k, n in lens.items():
            if n != len(rows):
                bad_records.append((rec.get("piece_id"), rec.get("window"), f"label '{k}' has {n} rows, features {len(rows)}"))
        if isinstance(labels, dict):
            for k, arr in labels.items():
                for v in arr:
                    label_rows += 1
                    if isinstance(v, (int, float)) and not math.isfinite(v):
                        label_nonfinite += 1

    dsl_ok = None
    if a.dsl:
        import dsl as dsl_mod

        dsl_fail = []
        lengths = []
        subtick = 0
        for rec in recs:
            maps = {
                "tempo": rec["tempo"],
                "dynamics": rec.get("dynamics", []),
                "rubato": rec.get("rubato", []),
                "asynchrony": rec.get("asynchrony", []),
                "articulation": rec.get("articulation", []),
                "movement": rec.get("movement", []),
            }
            # The token stream carries no part marker (CANONICAL §11 froze the vocabulary),
            # so the decoder needs the articulation part split handed back to it.
            part_sizes = []
            for row in maps["articulation"]:
                p = row[3] if len(row) > 3 else 1
                while len(part_sizes) < p:
                    part_sizes.append(0)
                part_sizes[p - 1] += 1
            for subset in ("training", "full"):
                toks = dsl_mod.encode_piece_v4(maps, subset=subset)
                lengths.append((subset, len(toks)))
                back, errors = dsl_mod.decode_piece_v4(
                    toks, subset=subset, artic_part_sizes=part_sizes or None
                )
                if errors:
                    dsl_fail.append((rec.get("piece_id"), rec.get("window"), subset, f"{errors} decode errors"))
                    continue
                for key, want in maps.items():
                    got = back.get(key, [])
                    if subset == "training" and key in ("articulation", "movement"):
                        continue  # outside the training subset by design
                    # Numeric, not textual: the DSL is digit-tokenised, so a date that went in
                    # as `0` comes back as `0.0`. Comparing the JSON text would call that a
                    # round-trip failure, which is a bug in the checker, not in the encoder.
                    diffs = _diff(_norm(want), _norm(got))
                    if not diffs:
                        continue
                    # ONE class is classified rather than failed, and only this one: an
                    # articulation *date* that misses by less than a tick. The DSL writes dates
                    # as decimal BEATS, and a real tuplet onset is not a terminating decimal in
                    # beats -- 30480 ticks is 42.333... -- so the digit tokeniser loses up to
                    # 0.024 ticks on it. The synthetic sampler never met this because its whole
                    # rhythm grid is dyadic. It is 3e-5 of a beat, i.e. 0.017 ms at 120 bpm,
                    # far below every observability floor in CANONICAL, and under A6's
                    # at-or-after targeting it still resolves to the same note. It also cannot
                    # reach training: articulation is a per-note head, not a token (LOG.md B2).
                    residual = [d for d in diffs if not (key == "articulation" and d[1] == 0 and d[2] < 1.0)]
                    subtick += len(diffs) - len(residual)
                    if residual:
                        dsl_fail.append((rec.get("piece_id"), rec.get("window"), subset, key, residual[:3]))
                        break
        dsl_ok = not dsl_fail
        if subtick:
            print(
                f"DSL: {subtick} articulation dates re-decoded within one tick "
                f"(decimal-beat quantisation of tuplet onsets; see the note in the source)"
            )
        by_subset = defaultdict(list)
        for s, n in lengths:
            by_subset[s].append(n)
        for s, ns in by_subset.items():
            ns.sort()
            over = sum(1 for n in ns if n > 448)
            print(
                f"DSL {s}: tokens min/median/max {ns[0]}/{ns[len(ns)//2]}/{ns[-1]} over {len(ns)} records"
                f"  (> MAX_TGT 448: {over})"
            )
        if dsl_fail:
            for f in dsl_fail[:10]:
                print(f"  DSL ROUND-TRIP FAIL {f}")

    print(f"\nrecords {len(recs)}, feature rows {total_rows}, width {n_expect}")
    print(f"non-finite feature values: {nonfinite}")
    print(f"label values {label_rows}, non-finite {label_nonfinite}")
    for era in sorted(per_era_rows):
        print(f"\n--- {era}: {per_era_rows[era]} rows")
        for i, name in enumerate(FEATURE_NAMES):
            lo, hi = per_era_min[era][i], per_era_max[era][i]
            flat = "  <-- CONSTANT" if lo == hi else ""
            print(f"   f{i:<2d} {name:<20s} {lo:12.5f} .. {hi:12.5f}{flat}")
    if bad_records:
        print("\nproblems:")
        for r in bad_records[:20]:
            print("  ", r)

    ok = nonfinite == 0 and label_nonfinite == 0 and not bad_records and (dsl_ok is not False)
    print("\n" + ("FEATURES_PASS" if ok else "FEATURES_FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
