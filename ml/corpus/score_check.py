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
does not. This script *classifies* those, and the classification is measured per note rather
than attributed to whatever seems likely:

1. **grace note** — matched by *identity*, not by count. ``build_msm.mjs`` records the
   ``xml:id`` and pitch of every zero-duration note it dropped (``droppedNotes``); this looks
   each one up in Verovio's timemap for the instant Verovio placed it, and pairs it off against
   a surplus note-on of the same pitch within the join tolerance. A budget ("no more surplus
   notes than grace notes dropped") is what this used to be, and a budget is something a defect
   can hide under. The same class also absorbs the members of a ``<chord @grace>``, whose
   pitches are read from the MEI because meico emits *nothing* for them — see the MEI leg.
2. **ornament realisation** — ``build_msm.mjs`` passes ``expandOrnaments: false``, so a
   ``<trill>``/``<mordent>``/``<turn>``/``<ornam>`` stays a *sign* in the MSM while Verovio's
   MIDI plays it out. Matched against the sign's own ``@startid`` note: within one beat before
   its onset, up to its release, within ±2 semitones (the upper/lower neighbour at a semitone
   or a whole tone). 145 signs on the pilot.
3. **notated tremolo** — ``<bTrem>``, one written chord that sounds as repeated attacks.
   Verovio's MIDI plays the attacks; meico's importer imports the chord. Matched when the piece
   *has* such an element (a fact read out of its MEI) and the surplus note-on re-articulates a
   pitch the MSM is still holding, i.e. lands strictly inside ``[date, date + duration)`` of a
   note the MSM does have.
4. **other re-attack** and 5. **residual**, both printed with dates and pitches.

**Repeats are NOT one of these classes on this corpus, and an earlier version of this
docstring said they were.** ``kern_to_mei.py`` runs with ``expandNever``, so Verovio does not
play the repeat either; the ``expansion_probe`` in ``mei/convert.json`` measures that directly
(Verovio's expansion changes the note count on exactly 1 of the 30 files, and that file's
*corpus* MIDI is the unexpanded one). The 179-note surplus that was attributed to a repeat on
Chopin op. 28/4 is class 3: that movement has no repeat barline in its kern, no ``<goto>`` in
its MSM, and its extra note-ons are scattered over 40 non-contiguous beats rather than forming
a contiguous section. ``hasGoto`` still marks the 16 movements whose repeat structure a v1.1
pass would have to resolve on both sides at once — it is a property of the corpus, just not a
cause of this surplus.

**What classes 2 and 3 mean for the corpus, stated because they are content decisions.** On
those windows the score model holds a sustained chord where the notation asks for repeated
attacks, and a plain principal where the notation asks for a trill. The interpretation sampled
over it is still canonical and the render is still exact; what is lost is that those attacks
are not notes the model can be asked to articulate. Importing them would mean generating notes
the MEI does not contain, which is precisely the ornament band SYSTEM.md defers to v1.1.

**And one MSM-only class, classified rather than waived.** A `<tie>` whose two notes meico
does *not* merge — the pilot has three, all of them ties across a staff or across a section
boundary — leaves the continuation note in the MSM while Verovio's MIDI merges it into the
first. Those are identified by looking the unmatched note's `xml:id` up in the MEI's `<tie
endid=…>` set, counted as `tie_continuation`, and excluded from the gate. Anything unmatched
and *not* a tie endpoint fails, because that is the shape a real pitch or rhythm defect has.

**A second gate, in the other direction: MEI -> MSM.** Everything above compares two
*realisations* of one parse. This one compares the MSM against the **document it was imported
from**, which is where an importer that drops an element silently shows up — and one does.
Every MEI ``<note>`` id must be in the MSM, or be a dropped grace note, or be a tie
continuation meico merged into its predecessor, or be a member of a ``<chord @grace>``.
``mei_absent_unexplained`` must be empty, and it is: 13 550 = 13 000 + 250 + 296 + 4 + 0.

The fourth of those classes is new and was found by this leg. meico's MEI importer emits a
zero-duration note for a single grace note, but emits **nothing at all** for a grace *chord*:
2 chords, 4 notes, on Haydn Hob. XVI:2 and Chopin op. 33/3. Nothing is corrupted — both routes
end with the note outside the corpus, which is the v1.0 decision for ornamental material — but
one route is counted in ``droppedZeroDuration`` and the other was invisible until it was
looked for. Filed for espressivo/meico rather than worked around here.
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


def note_spans(path: str):
    """``(pitch -> [(on, off)], id -> (on, off, pitch))`` for every MSM note.

    The first index answers "is this pitch already ringing at that instant" — how a re-attack
    of a held chord (``<bTrem>``) is told apart from a note the MSM is missing. The second
    answers "where is the note this ornament sign hangs on", which is how an ornament's
    realisation is told apart from both.
    """
    text = open(path).read()
    by_pitch: dict[int, list[tuple[float, float]]] = {}
    by_id: dict[str, tuple[float, float, int]] = {}
    for body in re.findall(r"<note\s([^>]*)/>", text):
        date = float(re.search(r'date="([-\d.eE+]+)"', body).group(1))
        dur = float(re.search(r'duration="([-\d.eE+]+)"', body).group(1))
        pitch = int(float(re.search(r'midi\.pitch="([-\d.eE+]+)"', body).group(1)))
        by_pitch.setdefault(pitch, []).append((date, date + dur))
        nid = re.search(r'xml:id="([^"]*)"', body)
        if nid:
            by_id[nid.group(1)] = (date, date + dur, pitch)
    return by_pitch, by_id


def tie_endids(mei_path: str) -> set[str]:
    """The `xml:id`s that are the *end* of a `<tie>` — the notes Verovio's MIDI merges away."""
    if not os.path.exists(mei_path):
        return set()
    text = open(mei_path).read()
    ids = {m for m in re.findall(r'<tie\b[^>]*\bendid="#([^"]+)"', text)}
    # `@tie="m"|"t"` is the inline spelling of the same relation; the NIFC and CCARH encodings
    # use both, and a note that is the continuation of a tie is merged away by meico either way.
    ids |= {m for m in re.findall(r'<note\b[^>]*\bxml:id="([^"]+)"[^>]*\btie="[mt]"', text)}
    return ids


def mei_note_elements(mei_path: str) -> dict[str, str]:
    """`xml:id -> the element's source text` for every `<note>` in an MEI."""
    if not os.path.exists(mei_path):
        return {}
    text = open(mei_path).read()
    return {m.group(1): m.group(0) for m in re.finditer(r'<note\b[^>]*\bxml:id="([^"]+)"[^>]*/?>', text)}


def grace_chord_noteids(mei_path: str) -> set[str]:
    """`xml:id`s of notes inside a `<chord @grace>` — an ornamental chord, not a struck one."""
    if not os.path.exists(mei_path):
        return set()
    text = open(mei_path).read()
    out: set[str] = set()
    for body in re.findall(r'<chord\b[^>]*\bgrace="[^"]*"[^>]*>(.*?)</chord>', text, re.S):
        out |= set(re.findall(r'xml:id="([^"]+)"', body))
    return out


_PNAME = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
_ACCID = {"n": 0, "s": 1, "f": -1, "ss": 2, "x": 2, "ff": -2, "": 0}


def mei_pitch(element: str) -> int | None:
    """MIDI pitch of an MEI `<note>` from `@pname`/`@oct`/`@accid[.ges]`, or `None`.

    Written pitch, deliberately: it is used only to identify a note the *importer* never
    produced, so there is no MSM value to inherit and no `@pnum` to read.
    """
    p = re.search(r'\bpname="([a-g])"', element)
    o = re.search(r'\boct="(-?\d+)"', element)
    if not p or not o:
        return None
    acc = re.search(r'\baccid(?:\.ges)?="([a-z]*)"', element)
    return (int(o.group(1)) + 1) * 12 + _PNAME[p.group(1)] + _ACCID.get(acc.group(1) if acc else "", 0)


#: MEI ornament signs Verovio realises in its MIDI export and meico leaves as signs
#: (`build_msm.mjs` passes `expandOrnaments: false`, because note-generating ornaments are a
#: v1.1 band). Their realisations are therefore MIDI-only by construction, not by defect.
ORNAMENT_ELEMENTS = ("trill", "mordent", "turn", "ornam")


def ornament_startids(mei_path: str) -> set[str]:
    """The `xml:id`s an ornament sign is attached to, from `@startid`."""
    if not os.path.exists(mei_path):
        return set()
    text = open(mei_path).read()
    out: set[str] = set()
    for el in ORNAMENT_ELEMENTS:
        out |= set(re.findall(rf'<{el}\b[^>]*\bstartid="#([^"]+)"', text))
    return out


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
        # ---- the other direction: is every MEI note accounted for in the MSM? --------------
        # `only_msm` above compares two *realisations*. This compares the MSM against the
        # document it was imported from, which is where an importer that silently drops an
        # element shows up — and one does. Every MEI `<note>` must be in the MSM, or be a
        # dropped grace note, or be a tie continuation meico merged into its predecessor, or be
        # a member of a `<chord @grace>`. Anything else is unexplained and fails.
        mei_notes = mei_note_elements(os.path.join(data, "mei", f"{pid}.mei"))
        msm_ids = {nid for _, _, nid in ided}
        dropped_ids = {g["id"] for g in piece.get("droppedNotes", [])}
        grace_chord_ids = grace_chord_noteids(os.path.join(data, "mei", f"{pid}.mei"))
        mei_tie, mei_grace_chord, mei_unexplained = 0, 0, []
        for nid in mei_notes:
            if nid in msm_ids or nid in dropped_ids:
                continue
            if nid in ties:
                mei_tie += 1
            elif nid in grace_chord_ids:
                mei_grace_chord += 1
            else:
                mei_unexplained.append(nid)

        # The gate: nothing the MSM claims may be absent from Verovio's realisation, unless it
        # is a tie continuation Verovio merged; and nothing the MEI contains may vanish from
        # the MSM without one of the four accounted-for reasons.
        ok = not unexplained and not mei_unexplained

        # Classify the MIDI-only note-ons. Order is deliberate: the two per-note tests are
        # facts about *that* note and come first; the grace count is only a budget and absorbs
        # what is left; whatever survives is named and printed.
        spans, by_id = note_spans(os.path.join(data, "msm", f"{pid}.msm"))
        orn = [by_id[i] for i in ornament_startids(os.path.join(data, "mei", f"{pid}.mei")) if i in by_id]
        # The dropped grace notes, by identity rather than by count: `build_msm.mjs` records
        # each one's `xml:id`, and Verovio's timemap says exactly when it placed it. That turns
        # "at most `droppedZeroDuration` of the surplus is grace notes" from a budget a defect
        # could hide under into a per-note match.
        tmap = json.load(open(os.path.join(data, "timemap", f"{pid}.json")))
        qstamp = {i: e["qstamp"] for e in tmap for i in e.get("on", [])}
        grace_events = sorted(
            (qstamp[g["id"]] * PPQ, g["pitch"]) for g in piece.get("droppedNotes", []) if g.get("id") in qstamp
        )
        # The grace CHORDS, which meico emits nothing at all for (not even a zero-duration
        # note), so they are absent from `droppedNotes` and would otherwise land in "residual".
        # Their pitch is read from the MEI, since there is no MSM note to read it from.
        grace_chord_events = sorted(
            (qstamp[i] * PPQ, mei_pitch(mei_notes[i]))
            for i in grace_chord_ids
            if i in qstamp and i not in msm_ids and mei_pitch(mei_notes.get(i, "")) is not None
        )
        # An ornament realisation is the principal's neighbours, sounding in or just before the
        # principal's own span. +-2 semitones covers the upper/lower neighbour of a trill,
        # mordent or turn at either a semitone or a whole tone; one beat of lead-in covers the
        # prefix Verovio places before the written onset.
        has_tremolo = piece.get("tremoloElements", 0) > 0

        def is_ornament(t, p):
            return any(on - PPQ <= t < off and abs(p - q) <= 2 for on, off, q in orn)

        def is_reattack(t, p):
            return any(on < t < off for on, off in spans.get(p, ()))

        grace_pool = list(grace_events) + list(grace_chord_events)
        grace, ornament, tremolo, reattack_other, residual_list = [], [], [], [], []
        for t, p in only_midi:
            hit = next((i for i, (gt, gp) in enumerate(grace_pool) if gp == p and abs(gt - t) <= a.tol_ticks), None)
            if hit is not None:
                grace_pool.pop(hit)
                grace.append((t, p))
            elif is_ornament(t, p):
                ornament.append((t, p))
            elif has_tremolo and is_reattack(t, p):
                tremolo.append((t, p))
            elif is_reattack(t, p):
                reattack_other.append((t, p))
            else:
                residual_list.append((t, p))
        residual = len(residual_list)
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
                midi_surplus_beyond_grace=len(only_midi) - dropped,
                midi_only_grace=len(grace),
                midi_only_grace_unmatched=len(grace_pool),
                midi_only_ornament=len(ornament),
                midi_only_reattack=len(tremolo),
                midi_only_reattack_other=len(reattack_other),
                midi_only_residual=residual,
                midi_only_residual_examples=residual_list[:10],
                ornament_startids=len(orn),
                tremolo_elements=piece.get("tremoloElements", 0),
                mei_notes=len(mei_notes),
                mei_absent_tie_continuation=mei_tie,
                mei_absent_grace_chord=mei_grace_chord,
                mei_absent_unexplained=[(i, mei_notes[i]) for i in mei_unexplained][:10],
                has_goto=repeats,
                resolved_notes=piece.get("resolvedNotes"),
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
            f"midi-only {len(only_midi):4d} = grace {len(grace):3d}/{dropped:3d} + orn {len(ornament):3d} "
            f"+ trem {len(tremolo):3d} + reattack {len(reattack_other):2d} + residual {residual:2d}  "
            f"maxD {max_d:.1f} tk {'OK' if ok else 'FAIL'}"
        )

    out = {
        "tol_ticks": a.tol_ticks,
        "ppq": PPQ,
        "build": index.get("build"),
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
    print(
        f"midi-only note-ons {sum(r['only_midi'] for r in rows)} = "
        f"{sum(r['midi_only_ornament'] for r in rows)} ornament realisations "
        f"({sum(r['ornament_startids'] for r in rows)} signs meico leaves unexpanded) + "
        f"{sum(r['midi_only_reattack'] for r in rows)} tremolo re-attacks "
        f"({sum(r['tremolo_elements'] for r in rows)} <bTrem>/<fTrem> over "
        f"{sum(1 for r in rows if r['tremolo_elements'])} piece) + "
        f"{sum(r['midi_only_grace'] for r in rows)} grace notes matched by id and timemap date + "
        f"{sum(r['midi_only_reattack_other'] for r in rows)} other re-attacks + "
        f"{sum(r['midi_only_residual'] for r in rows)} residual"
    )
    for r in rows:
        if r["midi_only_residual"]:
            print(f"  residual on {r['id']}: {r['midi_only_residual']} {r['midi_only_residual_examples']}")
    print(
        f"MEI -> MSM: {sum(r['mei_notes'] for r in rows)} MEI <note> elements = "
        f"{sum(r['msm'] for r in rows)} in the MSM + {sum(r['dropped_grace'] for r in rows)} dropped grace notes + "
        f"{sum(r['mei_absent_tie_continuation'] for r in rows)} tie continuations meico merges + "
        f"{sum(r['mei_absent_grace_chord'] for r in rows)} members of a <chord @grace> the importer emits nothing for "
        f"+ {sum(len(r['mei_absent_unexplained']) for r in rows)} unexplained"
    )
    for r in rows:
        if r["mei_absent_grace_chord"]:
            print(f"  <chord @grace> dropped whole on {r['id']}: {r['mei_absent_grace_chord']} note(s)")
        if r["mei_absent_unexplained"]:
            print(f"  UNEXPLAINED MEI notes absent from {r['id']}: {r['mei_absent_unexplained']}")
    print(
        f"repeat structure: {sum(1 for r in rows if r['has_goto'])}/{len(rows)} pieces carry a <goto>; "
        "the corpus plays none of them (expandNever on the Verovio side, no resolver on meico's) — "
        "MIDI-only notes are NOT repeats, see the docstring"
    )
    print(out["verdict"])
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
