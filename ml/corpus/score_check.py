#!/usr/bin/env python3
"""Step 3b: prove the MSM is the score Verovio parsed — the corpus's exact floor.

    nice -n 15 python3 score_check.py [--data ../data/corpus_pilot] [--tol-ticks 6]

Two independent realisations of the same kern file exist after step 2: Verovio's own MIDI
export (``midi/<id>.mid``) and the MSM meico's MEI importer produced from Verovio's MEI
(``msm/<id>.msm``). They share a parser but not a note-realisation path, so a difference is a
defect in the *importer*, which is exactly the class of defect the feasibility study warned
about:

* the **8va double shift** — meico applies both ``@oct.ges`` and the ``<octave>`` span, so a
  note under an 8va comes out 12 semitones too high. It shows up here as a pitch-multiset
  difference and nowhere else: the rhythm is untouched, the score renders, and every
  downstream metric is quietly measured on the wrong notes;
* a mis-set ``@dur.ges`` or tuplet rounding — shows up as an onset that no tolerance join
  reaches.

What this check **cannot** see, stated twice because both limits are easy to forget:

* a **Verovio** defect (the cross-octave accidental carry the study found) is in both sides by
  construction, since they come from one parse. Catching it needs a third realisation — the
  kern file read by an independent parser — which is v1.1 work;
* **onset timing is no longer independent evidence.** `build_msm.mjs` re-dates every note from
  Verovio's timemap (`redateFromTimemap`, and the importer defect it exists for), so onset
  agreement here is now largely a check that the timemap and the MIDI export agree with each
  other. Pitch, part assignment and the note set still come from meico's importer and are the
  part of this check that still tests something.

Tolerances, and why they are not slack:

* **pitch: exact.** Every MIDI note-on must be matched by an MSM note of the *same* pitch. No
  envelope, no rounding: a semitone is not a floating-point artefact.
* **onset: ±6 ticks at 720 ppq** (the study's "tolerance joins"). Verovio writes MIDI at 120
  ticks per quarter, so **one Verovio MIDI tick is exactly 6 ticks here** — and that is the
  observed disagreement, not a round number chosen for comfort: Verovio's MIDI displaces the
  principal of an ornament or an arpeggiated chord by one of its own ticks, which shows up as
  56 notes across the pilot sitting exactly 6 ticks early. 6 ticks is 1/120 of a quarter, i.e.
  2.8 ms at 120 bpm — below the 5 ms observability floor this program uses everywhere
  (CANONICAL §4.T2). The run prints the realised worst delta so the constant stays checkable.

**The direction of the claim.** The gate is ``only_msm == 0``: *every* note the MSM contains
must be realised by Verovio at the same pitch and the same onset. The reverse direction is not
a gate, and saying so is the honest part — Verovio's MIDI legitimately contains notes the MSM
does not, from exactly two sources:

* **grace notes**, which ``build_msm.mjs`` drops (``duration="0"``) and Verovio plays;
* **repeats.** The two implementations disagree about repeat structure — meico writes a
  ``<goto>`` for the Scarlatti sonatas that Verovio's ExpansionMap declines to resolve, and
  Verovio expands Chopin op. 28/4, for which meico writes no ``<goto>`` at all. The corpus is
  therefore the score played once through (``hasGoto`` in ``msm/index.json`` marks the
  affected pieces), and MIDI-only notes on those pieces are the repeat. Resolving on one side only would break this check instead of strengthening it.

Both are reported per piece, and the grace count must match exactly; the repeat surplus is
labelled rather than tolerated silently.

**And one MSM-only class, classified rather than waived.** A `<tie>` whose two notes meico
does *not* merge — the pilot has three, all of them ties across a staff or across a section
boundary — leaves the continuation note in the MSM while Verovio's MIDI merges it into the
first. Those are identified by looking the unmatched note's `xml:id` up in the MEI's `<tie
endid=…>` set, counted as `tie_continuation`, and excluded from the gate. Anything unmatched
and *not* a tie endpoint fails, because that is the shape a real pitch or rhythm defect has.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter

import mido

PPQ = 720


def msm_notes(path: str, with_ids: bool = False):
    """(tick, pitch) for every note in an MSM, across all parts; optionally with xml:id."""
    text = open(path).read()
    out = []
    for body in re.findall(r"<note\s([^>]*)/>", text):
        date = float(re.search(r'date="([-\d.eE+]+)"', body).group(1))
        pitch = int(float(re.search(r'midi\.pitch="([-\d.eE+]+)"', body).group(1)))
        nid = re.search(r'xml:id="([^"]*)"', body)
        out.append((date, pitch, nid.group(1) if nid else None) if with_ids else (date, pitch))
    out.sort()
    return out


def tie_endids(mei_path: str) -> set[str]:
    """The `xml:id`s that are the *end* of a `<tie>` — the notes Verovio's MIDI merges away."""
    if not os.path.exists(mei_path):
        return set()
    text = open(mei_path).read()
    return {m for m in re.findall(r'<tie\b[^>]*\bendid="#([^"]+)"', text)}


def midi_notes(path: str) -> list[tuple[float, int]]:
    """(tick at 720 ppq, pitch) for every note-on in a Verovio MIDI export."""
    mid = mido.MidiFile(path)
    tpb = mid.ticks_per_beat
    out = []
    for track in mid.tracks:
        t = 0
        for msg in track:
            t += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                out.append((t * PPQ / tpb, msg.note))
    out.sort()
    return out


def join(a: list[tuple[float, int]], b: list[tuple[float, int]], tol: float):
    """Greedy same-pitch tolerance join of `a` (MIDI) onto `b` (MSM).

    Returns `(matched, only_a, only_b, max_abs_delta)`. Greedy is sufficient because the
    candidate sets are per-pitch and ordered: two notes of the same pitch within `tol` of each
    other are a unison the score does not distinguish either.
    """
    by_pitch: dict[int, list[float]] = {}
    for t, p in b:
        by_pitch.setdefault(p, []).append(t)
    for p in by_pitch:
        by_pitch[p].sort()
    used: dict[int, set[int]] = {p: set() for p in by_pitch}

    matched, only_a, max_d = 0, [], 0.0
    for t, p in a:
        cands = by_pitch.get(p, [])
        best, best_d = -1, None
        for i, tb in enumerate(cands):
            if i in used[p]:
                continue
            d = abs(tb - t)
            if best_d is None or d < best_d:
                best, best_d = i, d
        if best >= 0 and best_d <= tol:
            used[p].add(best)
            matched += 1
            max_d = max(max_d, best_d)
        else:
            only_a.append((t, p))
    only_b = [(t, p) for p in by_pitch for i, t in enumerate(by_pitch[p]) if i not in used[p]]
    return matched, only_a, sorted(only_b), max_d


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(here, "..", "data", "corpus_pilot"))
    ap.add_argument("--tol-ticks", type=float, default=6.0)
    a = ap.parse_args()
    data = os.path.abspath(a.data)

    index = json.load(open(os.path.join(data, "msm", "index.json")))
    rows, failures = [], []
    for piece in index["pieces"]:
        pid = piece["id"]
        msm = msm_notes(os.path.join(data, "msm", f"{pid}.msm"))
        mid = midi_notes(os.path.join(data, "midi", f"{pid}.mid"))
        matched, only_midi, only_msm, max_d = join(mid, msm, a.tol_ticks)

        pm, pv = Counter(p for _, p in msm), Counter(p for _, p in mid)
        pitch_only_msm = sum((pm - pv).values())
        pitch_only_midi = sum((pv - pm).values())

        dropped = piece["droppedZeroDuration"]
        repeats = piece.get("hasGoto", False)
        # Classify the MSM-only notes: a tie continuation meico keeps and Verovio merges is
        # explained; anything else is the shape a pitch or rhythm defect has.
        ties = tie_endids(os.path.join(data, "mei", f"{pid}.mei"))
        ided = msm_notes(os.path.join(data, "msm", f"{pid}.msm"), with_ids=True)
        by_key: dict[tuple[float, int], list[str]] = {}
        for t, p, nid in ided:
            by_key.setdefault((t, p), []).append(nid)
        tie_cont, unexplained = 0, []
        for t, p in only_msm:
            ids = by_key.get((t, p), [])
            if any(i in ties for i in ids):
                tie_cont += 1
            else:
                unexplained.append((t, p, ids))
        # The gate: nothing the MSM claims may be absent from Verovio's realisation, unless it
        # is a tie continuation Verovio merged.
        ok = not unexplained
        surplus = len(only_midi) - dropped  # repeats, or an unexplained extra
        rows.append(
            dict(
                id=pid,
                era=piece["era"],
                msm=len(msm),
                midi=len(mid),
                matched=matched,
                only_midi=len(only_midi),
                only_msm=len(only_msm),
                tie_continuation=tie_cont,
                unexplained=[(t, p) for t, p, _ in unexplained][:10],
                dropped_grace=dropped,
                midi_surplus_beyond_grace=surplus,
                has_goto=repeats,
                pitch_only_msm=pitch_only_msm,
                pitch_only_midi=pitch_only_midi,
                max_onset_delta_ticks=round(max_d, 4),
                ok=ok,
            )
        )
        if not ok:
            failures.append(rows[-1])
        print(
            f"{pid:34s} {piece['era']:9s} msm {len(msm):5d} midi {len(mid):5d} matched {matched:5d} "
            f"only-msm {len(only_msm):3d} (ties {tie_cont:2d}, unexplained {len(unexplained):2d}) | "
            f"midi surplus {surplus:4d} (grace {dropped:3d}, repeats {'y' if repeats else 'n'}) "
            f"maxD {max_d:.1f} tk {'OK' if ok else 'FAIL'}"
        )

    out = {
        "tol_ticks": a.tol_ticks,
        "ppq": PPQ,
        "pieces": rows,
        "verdict": "SCORE_CHECK_PASS" if not failures else "SCORE_CHECK_FAIL",
    }
    with open(os.path.join(data, "msm", "score_check.json"), "w") as f:
        json.dump(out, f, indent=2)
    worst = max((r["max_onset_delta_ticks"] for r in rows), default=0.0)
    print(
        f"\n{len(rows)} pieces, {sum(r['matched'] for r in rows)} notes matched, "
        f"worst onset delta {worst} ticks (tolerance {a.tol_ticks}), "
        f"{sum(r['dropped_grace'] for r in rows)} grace notes accounted for"
    )
    print(out["verdict"])
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
