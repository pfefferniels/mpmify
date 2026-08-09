"""Validate the v4 Python rendering chain (movement + asynchrony) against the meico fork.

The project's standard of proof is EXACT reproduction, so every comparison here is on the
raw IEEE-754 bit pattern -- not ``==`` (which equates ``+0.0``/``-0.0``) and not a
``%.9f``-formatted difference (which is how the fdlibm 1-ulp divergence hid for months).
The verdict is EXACT only when *nothing* differs in a single bit.

Two modes, picked automatically:

**pilot mode** -- ``ml/data/pilot_v4*.jsonl`` exists (Team D's generator).  Every note's
``ms_on`` / ``ms_off`` / ``velocity`` and every control-change point is recomputed with
``perf_chain_v4.PerfChainV4`` and compared against what the renderer wrote.  The reader
sniffs the record schema (single-part v3-style, or ``parts: [...]``) and the CC ground-truth
key, and prints what it found so a silently-empty comparison cannot pass.

**java mode** -- no pilot yet (or ``--java`` forced).  A battery of hand-built cases is
written out as MSM+MPM, rendered by the Java fork through ``ml/java/RenderMpm.java`` in one
JVM, and the augmented MSM is parsed back.  The cases are chosen to hit every quirk the
ports reproduce on purpose; ``--list`` prints them with the quirk each one covers.  This
mode generates **no dataset** -- the files live in a temp directory and are deleted unless
``--keep`` is given.

``--negative`` adds the negative-control battery: each control monkey-patches one plausible
*alternative* reading of the reference (the "obvious correct" version of a quirk) and the
suite must flip to MISMATCH.  A control that stays EXACT is a hole in the case battery, not
a success -- that is the only way to show a green run is evidence rather than an accident.

**attribution mode** -- ``--attribute <pilot.jsonl>``.  When a pilot file and this port
disagree, three parties could be wrong: the port, the renderer that wrote the file, or the
Java fork.  This mode re-renders exactly the differing records through ``ml/java/RenderMpm``
and prints python / JSONL / fork bit patterns side by side, so the attribution is
reproducible rather than asserted.

``--espressivo`` renders the same battery through the TypeScript renderer's frozen facade
(``performMsmToData``) instead, closing the Python/Java/TS triangle and additionally
checking the *grouped* ``controlChanges`` shape that ``PartPerf.cc`` mirrors.  Fields hit by
a known espressivo defect are quarantined from the verdict and reported with a minimal
repro (see :data:`ESPRESSIVO_BUGS`) rather than silently tolerated or silently failed.

Usage::

    python3 validate_v4.py                    # pilot if present, else java
    python3 validate_v4.py --java [--negative] [--espressivo] [--keep] [--verbose] [--list]
    python3 validate_v4.py --espressivo       # TS cross-check only
    python3 validate_v4.py ../data/pilot_v4.jsonl [--verbose] [--cross-java [N]]
    python3 validate_v4.py --attribute ../data/pilot_v4_exact.jsonl
"""

import glob
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

from movement_math import DEFAULT_MOVEMENT_SAMPLE_MAX_STEP
from perf_chain_v4 import PerfChainV4

HERE = os.path.dirname(os.path.abspath(__file__))
ML = os.path.dirname(HERE)
MEICO = os.environ.get("MEICO", "/Users/nielspfeffer/Projects/meico")
JAVA_OUT = os.path.join(ML, "java", "out")
CLASSPATH = os.pathsep.join([JAVA_OUT,
                             os.path.join(MEICO, "out", "production", "meico"),
                             os.path.join(MEICO, "externals", "*")])
PPQ = 720
XML_ID = "{http://www.w3.org/XML/1998/namespace}id"


# ------------------------------------------------------------------ bit-exact comparison

def _bits(x):
    return struct.unpack("<Q", struct.pack("<d", x))[0]


def _bit_identical(a, b):
    return _bits(a) == _bits(b)


def _ulps(a, b):
    if _bit_identical(a, b):
        return 0.0
    if math.isnan(a) or math.isnan(b) or math.isinf(a) or math.isinf(b):
        return float("inf")
    if a == b:
        return 0.0
    return abs(a - b) / math.ulp(max(abs(a), abs(b), 5e-324))


class Diffs:
    """Accumulates per-field bit-exactness statistics.

    ``None`` means "the attribute does not exist on this side". Absent on **both** sides is
    an exact agreement, not a hole -- meico's empty-dynamicsMap path (perf_chain_v4 D0)
    legitimately produces notes with no ``velocity`` attribute, and demanding a number there
    would be demanding a value meico never wrote. Absent on exactly one side is a mismatch.
    Both cases are counted separately from the numeric ones so a run cannot pass by having
    compared nothing.
    """

    def __init__(self, fields):
        self.fields = list(fields)
        self.n = {f: 0 for f in self.fields}
        self.neq = {f: 0 for f in self.fields}
        self.absent = {f: 0 for f in self.fields}
        self.max_abs = {f: 0.0 for f in self.fields}
        self.max_ulp = {f: 0.0 for f in self.fields}
        self.worst = {f: None for f in self.fields}
        self.missing = 0

    def add(self, field, got, exp, where):
        self.n[field] += 1
        if got is None and exp is None:
            self.absent[field] += 1
            return
        if got is None or exp is None or (got != got) != (exp != exp):
            self.missing += 1
            self.neq[field] += 1
            self.max_abs[field] = float("inf")
            self.max_ulp[field] = float("inf")
            self.worst[field] = (where, got, exp)
            return
        if not _bit_identical(got, exp):
            self.neq[field] += 1
            d = abs(got - exp)
            if d >= self.max_abs[field]:
                self.max_abs[field] = d
                self.worst[field] = (where, got, exp)
            self.max_ulp[field] = max(self.max_ulp[field], _ulps(got, exp))

    def ok(self):
        return sum(self.neq.values()) == 0 and self.missing == 0

    def report(self, indent="  "):
        for f in self.fields:
            extra = ("   attribute absent on both sides = %d" % self.absent[f]
                     if self.absent[f] else "")
            print("%s%-14s max|diff| = %.9f   max ulp = %.1f   non-bit-identical = %d / %d%s"
                  % (indent, f, self.max_abs[f], self.max_ulp[f], self.neq[f], self.n[f],
                     extra))

    def report_worst(self, indent="  "):
        for f in self.fields:
            if self.worst[f] is not None:
                where, got, exp = self.worst[f]
                print("%sworst %s: %s got=%r exp=%r" % (indent, f, where, got, exp))


# =======================================================================================
#  JAVA MODE -- hand-built cases rendered by the fork
# =======================================================================================

def _num(v):
    """Shortest round-tripping decimal; ``Double.parseDouble`` reads it back bit-exactly."""
    return repr(float(v))


def _msm(title, parts):
    """Minimal MSM. ``parts`` = [(name, number, channel, port, [(date, dur, pitch), ...])]."""
    out = ['<?xml version="1.0"?>',
           '<msm title="%s" pulsesPerQuarter="%d">' % (title, PPQ),
           '<global><header /><dated><timeSignatureMap /><keySignatureMap /><markerMap />'
           '<sectionMap /><phraseMap /><sequencingMap /><pedalMap /><miscMap /></dated>'
           '</global>']
    for name, number, ch, port, notes in parts:
        out.append('<part name="%s" number="%d" midi.channel="%d" midi.port="%d">'
                   '<header /><dated>'
                   '<timeSignatureMap><timeSignature date="0.0" numerator="4.0" '
                   'denominator="4" /></timeSignatureMap><keySignatureMap /><markerMap />'
                   '<sequencingMap /><pedalMap /><phraseMap /><miscMap><tupletSpanMap />'
                   '</miscMap><score>' % (name, number, ch, port))
        for i, (date, dur, pitch) in enumerate(notes):
            out.append('<note xml:id="%s_n%d" date="%s" midi.pitch="%s" pitchname="x" '
                       'accidentals="0.0" octave="3.0" duration="%s" />'
                       % (name, i, _num(date), _num(pitch), _num(dur)))
        out.append('</score></dated></part>')
    out.append('</msm>')
    return "".join(out)


def _maps_xml(maps):
    """MPM map elements for one ``<dated>``; ``None``/absent = no such map element."""
    out = []
    tempo = maps.get("tempo", None)
    if tempo is not None:
        out.append("<tempoMap>")
        for row in tempo:
            a = 'date="%s" bpm="%s" beatLength="0.25"' % (_num(row[0]), _num(row[1]))
            if row[2] is not None:
                a += ' transition.to="%s"' % _num(row[2])
                if row[3] is not None:
                    a += ' meanTempoAt="%s"' % _num(row[3])
            out.append("<tempo %s />" % a)
        out.append("</tempoMap>")
    dyn = maps.get("dynamics", None)
    if dyn is not None:
        out.append("<dynamicsMap>")
        for row in dyn:
            a = 'date="%s" volume="%s"' % (_num(row[0]), _num(row[1]))
            if row[2] is not None:
                a += ' transition.to="%s"' % _num(row[2])
                if row[3] is not None:
                    a += ' curvature="%s"' % _num(row[3])
                if row[4] is not None:
                    a += ' protraction="%s"' % _num(row[4])
            out.append("<dynamics %s />" % a)
        out.append("</dynamicsMap>")
    art = maps.get("articulation", None)
    if art is not None:
        out.append("<articulationMap>")
        for row in art:
            out.append('<articulation date="%s" relativeDuration="%s" '
                       'absoluteVelocityChange="%s" />'
                       % (_num(row[0]), _num(row[1]), _num(row[2])))
        out.append("</articulationMap>")
    rub = maps.get("rubato", None)
    if rub is not None:
        out.append("<rubatoMap>")
        for row in rub:
            out.append('<rubato date="%s" frameLength="%s" intensity="%s" lateStart="%s" '
                       'earlyEnd="%s" loop="%s" />'
                       % (_num(row[0]), _num(row[1]), _num(row[2]), _num(row[3]),
                          _num(row[4]), "true" if row[5] else "false"))
        out.append("</rubatoMap>")
    mov = maps.get("movement", None)
    if mov is not None:
        out.append("<movementMap>")
        for row in mov:
            row = list(row) + [None] * (6 - len(row))
            a = 'date="%s"' % _num(row[0])
            if row[1] is not None:
                a += ' position="%s"' % _num(row[1])
            if row[2] is not None:
                a += ' transition.to="%s"' % _num(row[2])
            if row[3] is not None:
                a += ' curvature="%s"' % _num(row[3])
            if row[4] is not None:
                a += ' protraction="%s"' % _num(row[4])
            if row[5] is not None:
                a += ' controller="%s"' % row[5]
            out.append("<movement %s />" % a)
        out.append("</movementMap>")
    asyn = maps.get("asynchrony", None)
    if asyn is not None:
        out.append("<asynchronyMap>")
        for row in asyn:
            out.append('<asynchrony date="%s" milliseconds.offset="%s" />'
                       % (_num(row[0]), _num(row[1])))
        out.append("</asynchronyMap>")
    return "".join(out)


def _mpm(global_maps, parts):
    """``parts`` = [(name, number, channel, port, maps_dict)]."""
    out = ['<?xml version="1.0"?>',
           '<mpm xmlns="http://www.cemfi.de/mpm/ns/1.0">',
           '<performance name="perf" pulsesPerQuarter="%d">' % PPQ,
           '<global><header /><dated>', _maps_xml(global_maps or {}), '</dated></global>']
    for name, number, ch, port, maps in parts:
        out.append('<part name="%s" number="%d" midi.channel="%d" midi.port="%d">'
                   '<header /><dated>%s</dated></part>'
                   % (name, number, ch, port, _maps_xml(maps or {})))
    out.append("</performance></mpm>")
    return "".join(out)


# ------------------------------------------------------------------------- the battery

_SCORE_A = [(0, 720, 60), (720, 720, 62), (1440, 1440, 64)]
_SCORE_B = [(0, 1440, 48), (1440, 1440, 50)]
_SCORE_C = [(0, 360, 60), (360, 360, 62), (720, 360, 64), (1080, 360, 65),
            (1440, 720, 67), (2160, 720, 69), (2880, 1440, 71)]
#: a chord at 1440 plus isolated notes, for the articulation-targeting quirk (A6)
_SCORE_E = [(0, 360, 60), (720, 360, 62), (1440, 360, 64), (1440, 360, 67),
            (1440, 360, 71), (2160, 360, 72), (2880, 360, 74)]
#: two notes whose TICK end and PERFORMED end fall on opposite sides of tick 2880 once
#: articulation has scaled their duration.perf -- and whose end dates are non-monotone in
#: map order, which is what puts the tempo stage's pendingDurations `continue` under test.
_SCORE_D = [(0, 720, 60), (720, 720, 62), (1440, 1440, 64), (2160, 600, 67),
            (2880, 720, 69), (3600, 720, 71)]

_TEMPO_FLAT = [[0, 100.0, None, None]]
_TEMPO_CURVE = [[0, 100.0, None, None],
                [1440, 140.0, 80.0, 0.4],
                [2880, 80.0, None, None]]
_DYN_CURVE = [[0, 60.0, None, None, None],
              [1440, 60.0, 100.0, 0.3, -0.4],
              [2880, 100.0, None, None, None]]


def _cases():
    """(name, coverage note, msm_xml, mpm_xml, py_spec) tuples.

    ``py_spec`` = ``(global_maps, [part_dict, ...], movement_sample_max_step)`` for
    :class:`PerfChainV4`; the part dicts carry ``notes`` as ``(date, duration)`` pairs.
    """
    cases = []

    def add(name, note, parts_msm, global_maps, parts_mpm, max_step=None):
        msm = _msm(name, parts_msm)
        mpm = _mpm(global_maps, parts_mpm)
        py_parts = []
        for (pname, number, _ch, _port, notes), (_n2, _num2, _c2, _p2, maps) in zip(
                parts_msm, parts_mpm):
            spec = {"number": number, "name": pname,
                    "notes": [(d, u) for (d, u, _p) in notes]}
            spec.update({k: v for k, v in (maps or {}).items()})
            py_parts.append(spec)
        cases.append((name, note, msm, mpm, (global_maps or {}, py_parts, max_step)))

    # --- movement ----------------------------------------------------------------------
    add("mov_basic",
        "Q1 last instruction not rendered, Q2 position inheritance from entry 0, Q3 "
        "duplicated endpoints, x127 scaling, controller sustain+soft, curve under a tempo "
        "transition",
        [("P1", 1, 0, 0, _SCORE_A)],
        {"tempo": _TEMPO_CURVE, "dynamics": _DYN_CURVE},
        [("P1", 1, 0, 0, {"movement": [
            [0, 0.0, 1.0, 0.25, 0.3, "sustain"],
            [1440, None, 0.2, 0.6, -0.5, "soft"],
            [2880, 0.2, None, None, None, None]]})])

    add("mov_defaults",
        "Q6 field-initialiser defaults: no curvature (=0.4), no protraction (=0.0), no "
        "controller (=sustain)",
        [("P1", 1, 0, 0, _SCORE_A)],
        {"tempo": _TEMPO_FLAT},
        [("P1", 1, 0, 0, {"movement": [[0, 0.0, 1.0, None, None, None],
                                       [2880, 1.0, None, None, None, None]]})])

    add("mov_constant",
        "Q4 constant movement (no transition.to) in a non-last slot -> 3 identical points, "
        "no appended end point",
        [("P1", 1, 0, 0, _SCORE_A)],
        {"tempo": _TEMPO_FLAT},
        [("P1", 1, 0, 0, {"movement": [[0, 0.6, None, None, None, "sustain"],
                                       [1440, 0.6, 0.1, 0.0, 0.0, "sustain"],
                                       [2880, 0.1, None, None, None, "sustain"]]})])

    add("mov_descending",
        "descending ramp (1.0 -> 0.0) plus protraction at both signs; subdivision from the "
        "other direction",
        [("P1", 1, 0, 0, _SCORE_C)],
        {"tempo": _TEMPO_CURVE},
        [("P1", 1, 0, 0, {"movement": [[0, 1.0, 0.0, 0.9, 0.7, "sustain"],
                                       [1440, 0.0, 1.0, 0.0, -0.7, "sustain"],
                                       [2880, 1.0, 0.35, 0.5, 0.0, "sustain"],
                                       [4320, 0.35, None, None, None, "sustain"]]})])

    add("mov_nonmonotone",
        "Q5 curvature outside [0,1] (not clamped by MovementMap) -> non-monotone x(t) -> "
        "GenericMap.insertElement reorders the events",
        [("P1", 1, 0, 0, _SCORE_A)],
        {"tempo": _TEMPO_FLAT},
        [("P1", 1, 0, 0, {"movement": [[0, 0.0, 1.0, 2.0, 0.0, "sustain"],
                                       [2880, 1.0, None, None, None, "sustain"]]})])

    add("mov_interleaved_controllers",
        "three segments, controllers sustain/soft/sustain -> two streams, grouped by "
        "first appearance, each non-contiguous in the flat positionMap",
        [("P1", 1, 0, 0, _SCORE_C)],
        {"tempo": _TEMPO_FLAT},
        [("P1", 1, 0, 0, {"movement": [[0, 0.0, 0.5, 0.2, 0.0, "sustain"],
                                       [1440, 0.5, 0.9, 0.2, 0.0, "soft"],
                                       [2880, 0.9, 0.1, 0.2, 0.0, "sustain"],
                                       [4320, 0.1, None, None, None, "sustain"]]})])

    add("mov_tiny_step",
        "a transition smaller than maxStepSize -> no subdivision at all (2 samples + 2 "
        "bracket points)",
        [("P1", 1, 0, 0, _SCORE_A)],
        {"tempo": _TEMPO_FLAT},
        [("P1", 1, 0, 0, {"movement": [[0, 0.5, 0.55, 0.4, 0.0, "sustain"],
                                       [2880, 0.55, None, None, None, "sustain"]]})])

    add("mov_no_tempo",
        "no tempoMap anywhere -> TempoMap.renderTempoToMap(map, ppq, null): "
        "milliseconds.date := date.perf for the positionMap too",
        [("P1", 1, 0, 0, _SCORE_A)],
        {},
        [("P1", 1, 0, 0, {"movement": [[0, 0.0, 1.0, 0.3, 0.1, "sustain"],
                                       [2880, 1.0, None, None, None, "sustain"]]})])

    add("mov_empty_tempo",
        "empty <tempoMap /> -> meico's fixed-100-bpm branch (600*date/ppq) on the "
        "positionMap",
        [("P1", 1, 0, 0, _SCORE_A)],
        {"tempo": []},
        [("P1", 1, 0, 0, {"movement": [[0, 0.0, 1.0, 0.3, 0.1, "sustain"],
                                       [2880, 1.0, None, None, None, "sustain"]]})])

    add("mov_max_step",
        "movementSampleMaxStep left at its 0.1 default but a full-swing ramp -> the dense "
        "sampling path (>= 16 points)",
        [("P1", 1, 0, 0, _SCORE_C)],
        {"tempo": _TEMPO_CURVE, "dynamics": _DYN_CURVE},
        [("P1", 1, 0, 0, {"movement": [[0, 0.0, 1.0, 0.05, 0.0, "sustain"],
                                       [4320, 1.0, None, None, None, "sustain"]]})],
        max_step=DEFAULT_MOVEMENT_SAMPLE_MAX_STEP)

    # --- asynchrony --------------------------------------------------------------------
    add("mov_negative_date",
        "the `md.startDate >= 0` guard: a movement at a negative date renders nothing, and "
        "the movement AFTER it still does",
        [("P1", 1, 0, 0, _SCORE_A)],
        {"tempo": _TEMPO_FLAT},
        [("P1", 1, 0, 0, {"movement": [[-1440, 0.9, 0.4, 0.2, 0.0, "sustain"],
                                       [0, 0.4, 1.0, 0.2, 0.0, "sustain"],
                                       [2880, 1.0, None, None, None, "sustain"]]})])

    add("mov_dangling_tempo",
        "final tempo instruction carries a transition.to -> endDate = Double.MAX_VALUE is "
        "the divisor in getTempoAt; the positionMap is timed through that segment",
        [("P1", 1, 0, 0, _SCORE_C)],
        {"tempo": [[0, 100.0, None, None], [1440, 120.0, 60.0, 0.35]]},
        [("P1", 1, 0, 0, {"movement": [[0, 0.0, 1.0, 0.3, 0.2, "sustain"],
                                       [4320, 1.0, None, None, None, "sustain"]],
                          "asynchrony": [[0, 11.0], [2880, -250.0]]})])

    add("mov_single_instruction",
        "a movementMap of ONE instruction renders nothing (Q1) -- meico still appends an "
        "empty <positionMap/>, so the part has zero position events, not none at all",
        [("P1", 1, 0, 0, _SCORE_A)],
        {"tempo": _TEMPO_FLAT},
        [("P1", 1, 0, 0, {"movement": [[0, 0.3, 0.9, 0.4, 0.0, "sustain"]]})])

    add("overlap_pending",
        "NON-CANONICAL coverage: a sustained voice overlapping the melody makes note end "
        "dates non-monotone in map order, which is the only configuration that separates "
        "RubatoMap's pendingDurations `break` from TempoMap's `continue`",
        [("P1", 1, 0, 0, [(0, 720, 60), (720, 720, 62), (1440, 2880, 48), (1440, 720, 64),
                          (2160, 720, 65), (2880, 720, 67), (3600, 720, 69)])],
        {"tempo": _TEMPO_CURVE, "dynamics": _DYN_CURVE,
         "rubato": [[0, 720, 1.6, 0.0, 1.0, 1], [2880, 720, 1.0, 0.0, 1.0, 0]]},
        [("P1", 1, 0, 0, {"asynchrony": [[0, -22.0], [2160, 17.0]],
                          "movement": [[0, 0.1, 0.95, 0.45, -0.3, "sustain"],
                                       [2880, 0.95, None, None, None, "sustain"]]})])

    add("artic_offdate",
        "A6: an articulation whose date has NO note is not skipped -- getAllElementsAt is "
        "at-or-AFTER and adds the found element unconditionally, so it articulates the next "
        "note, and for a chord landed on this way only the FIRST note. Dates 360/400 both "
        "land on the note at 720 (stacking), 1080 lands on the first note of the 1440 "
        "chord, 1440 hits all three, 2500 lands on 2880, 5000 is past the last note and is "
        "dropped. v4 makes this routine: articulation dates are drawn from BOTH parts' "
        "onsets and the map is global.",
        [("P1", 1, 0, 0, _SCORE_E)],
        {"tempo": _TEMPO_CURVE, "dynamics": _DYN_CURVE,
         "articulation": [[360, 0.5, 5.0], [400, 1.2, -3.0], [1080, 0.7, 9.0],
                          [1440, 0.6, -11.0], [2500, 1.1, 4.0], [5000, 0.4, 20.0]]},
        [("P1", 1, 0, 0, {"asynchrony": [[0, 14.0]],
                          "movement": [[0, 0.2, 0.8, 0.3, 0.1, "sustain"],
                                       [2880, 0.8, None, None, None, "sustain"]]})])

    add("asyn_straddle",
        "A1/A2: a note whose tick end falls in the NEXT asynchrony segment gets the next "
        "segment's offset on its end and the current one's on its onset, floored at 1 ms",
        [("P1", 1, 0, 0, _SCORE_A)],
        {"tempo": _TEMPO_CURVE, "dynamics": _DYN_CURVE},
        [("P1", 1, 0, 0, {"asynchrony": [[0, -30.0], [1440, 12.5]]})])

    add("asyn_before_first",
        "asynchronyMap starting after date 0: notes before it keep their onset but a note "
        "whose TICK end reaches into the segment still gets its end shifted (floor 1 ms)",
        [("P1", 1, 0, 0, _SCORE_C)],
        {"tempo": _TEMPO_FLAT},
        [("P1", 1, 0, 0, {"asynchrony": [[1080, 40.0], [2880, -75.0]]})])

    add("asyn_clamp_zero",
        "A3 start clamp: an offset far more negative than the onset -> max(0, ...) pins "
        "several onsets to exactly 0.0",
        [("P1", 1, 0, 0, _SCORE_C)],
        {"tempo": _TEMPO_FLAT},
        [("P1", 1, 0, 0, {"asynchrony": [[0, -5000.0]]})])

    add("asyn_clamp_end",
        "A3 end clamp: a huge negative offset that would put the end before the start -> "
        "max(ms, start+1)",
        [("P1", 1, 0, 0, _SCORE_C)],
        {"tempo": _TEMPO_FLAT},
        [("P1", 1, 0, 0, {"asynchrony": [[0, 0.0], [720, -100000.0]]})])

    add("asyn_tick_vs_perf_end",
        "asynchrony membership is decided on the RAW TICK end (duration + date), never on "
        "date.end.perf: note@1440 has tick end 2880 (carried past the boundary) but perf "
        "end 2160 (relativeDuration 0.5), and note@2160 has tick end 2760 but perf end "
        "3060 (relativeDuration 1.5) -- the two disagree in opposite directions. Also the "
        "only case with non-monotone note end dates.",
        [("P1", 1, 0, 0, _SCORE_D)],
        {"tempo": _TEMPO_CURVE, "dynamics": _DYN_CURVE,
         "articulation": [[1440, 0.5, 5.0], [2160, 1.5, -7.0]]},
        [("P1", 1, 0, 0, {"asynchrony": [[0, 10.0], [2880, -60.0]],
                          "movement": [[0, 0.0, 0.7, 0.3, 0.0, "sustain"],
                                       [2880, 0.7, None, None, None, "sustain"]]})])

    add("asyn_many_segments",
        "one asynchrony per beat, alternating sign -> every note crosses a boundary",
        [("P1", 1, 0, 0, _SCORE_C)],
        {"tempo": _TEMPO_CURVE},
        [("P1", 1, 0, 0, {"asynchrony": [[0, 7.0], [720, -13.0], [1440, 21.0],
                                         [2160, -3.5], [2880, 44.0], [3600, -60.0]]})])

    # --- combined / multi-part ---------------------------------------------------------
    add("two_parts_local_maps",
        "per-part maps shadowing the global ones: P1 local asynchrony + local movement, "
        "P2 inherits the global movement and has its own asynchrony",
        [("P1", 1, 0, 0, _SCORE_A), ("P2", 2, 1, 0, _SCORE_B)],
        {"tempo": _TEMPO_CURVE, "dynamics": _DYN_CURVE,
         "movement": [[0, 0.0, 0.8, 0.4, 0.0, "sustain"],
                      [2880, 0.8, None, None, None, "sustain"]]},
        [("P1", 1, 0, 0, {"asynchrony": [[0, -30.0], [1440, 12.5]],
                          "movement": [[0, 0.1, 0.9, 0.15, 0.45, "soft"],
                                       [1440, 0.9, 0.3, 0.7, -0.2, "soft"],
                                       [2880, 0.3, None, None, None, "soft"]]}),
         ("P2", 2, 1, 0, {"asynchrony": [[0, 25.0]]})])

    add("full_stack",
        "all six maps at once, two parts: tempo curve + dynamics curve + articulation + "
        "rubato + movement + asynchrony",
        [("P1", 1, 0, 0, _SCORE_C), ("P2", 2, 1, 0, _SCORE_B)],
        {"tempo": _TEMPO_CURVE, "dynamics": _DYN_CURVE,
         "articulation": [[0, 0.55, 12.0], [1440, 1.12, -9.0], [2880, 0.7, 4.0]],
         "rubato": [[0, 720, 1.45, 0.0, 1.0, 1], [2880, 720, 1.0, 0.0, 1.0, 0]]},
        [("P1", 1, 0, 0, {"asynchrony": [[0, -18.0], [2880, 33.0]],
                          "movement": [[0, 0.0, 1.0, 0.35, -0.25, "sustain"],
                                       [1440, 1.0, 0.0, 0.65, 0.5, "sustain"],
                                       [2880, 0.0, 0.55, 0.1, 0.0, "soft"],
                                       [4320, 0.55, None, None, None, "soft"]]}),
         ("P2", 2, 1, 0, {"asynchrony": [[0, 9.0]],
                          "movement": [[0, 0.25, 0.75, 0.0, 0.0, "sustain"],
                                       [2880, 0.75, None, None, None, "sustain"]]})])

    # --- dynamics states v3 could not reach ---------------------------------------------
    add("dyn_empty_local",
        "D0: an EMPTY but present local <dynamicsMap/> shadows the global one and "
        "renderDynamicsToMap returns null BEFORE writing anything -> P1's notes get NO "
        "velocity attribute at all (not 100.0), no channelVolumeMap, and the global "
        "articulation's absoluteVelocityChange is silently dropped (velocityAtt == null) "
        "while relativeDuration still scales duration.perf. P2 inherits the global "
        "dynamicsMap and shows the contrast on the same articulations.",
        [("P1", 1, 0, 0, _SCORE_C), ("P2", 2, 1, 0, _SCORE_B)],
        {"tempo": _TEMPO_CURVE, "dynamics": _DYN_CURVE,
         "articulation": [[0, 0.55, 12.0], [1440, 1.12, -9.0], [2880, 0.7, 4.0]]},
        [("P1", 1, 0, 0, {"dynamics": [],
                          "movement": [[0, 0.0, 0.9, 0.3, 0.0, "sustain"],
                                       [2880, 0.9, None, None, None, "sustain"]],
                          "asynchrony": [[0, 8.0]]}),
         ("P2", 2, 1, 0, {})])

    add("dyn_no_dynamics_map_at_all",
        "D0's other half: NO dynamicsMap anywhere -> the static overload writes an explicit "
        "velocity=100.0 on every note, so the same articulation DOES change the velocity. "
        "Also no channelVolumeMap (it is created only by the instance method).",
        [("P1", 1, 0, 0, _SCORE_C)],
        {"tempo": _TEMPO_CURVE,
         "articulation": [[0, 0.55, 12.0], [1440, 1.12, -9.0], [2880, 0.7, 4.0]]},
        [("P1", 1, 0, 0, {"movement": [[0, 0.0, 0.9, 0.3, 0.0, "sustain"],
                                       [2880, 0.9, None, None, None, "sustain"]]})])

    add("dyn_out_of_range_curve",
        "D1: dynamics curvature 1.7 and protraction -2.5 are CLAMPED at render time by "
        "getDynamicsDataOf (ensureCurvatureBoundaries/ensureProtractionBoundaries) to 1.0 "
        "and -1.0. The movementMap in the same case carries the same out-of-range numbers "
        "and is NOT clamped (Q5), so one case holds both halves of the asymmetry.",
        [("P1", 1, 0, 0, _SCORE_C)],
        {"tempo": _TEMPO_FLAT,
         "dynamics": [[0, 40.0, None, None, None],
                      [720, 40.0, 110.0, 1.7, -2.5],
                      [2880, 110.0, 30.0, -0.9, 3.0],
                      [4320, 30.0, None, None, None]]},
        [("P1", 1, 0, 0, {"movement": [[0, 0.0, 1.0, 1.7, -2.5, "sustain"],
                                       [2880, 1.0, None, None, None, "sustain"]]})])

    add("local_null_maps_inherit",
        "map resolution: P1's part element carries NO tempoMap/dynamicsMap/movementMap, "
        "which the Python spec spells as an explicit `None` local map. meico's "
        "`if (localMap == null) localMap = globalMap;` (Performance.java:479-494) has no "
        "'local null map' state at all, so P1 must render IDENTICALLY to P2, which spells "
        "the same thing by omission. Treating `None` as a shadowing null map would drop the "
        "global movementMap and fall back to 1 tick = 1 ms.",
        [("P1", 1, 0, 0, _SCORE_A), ("P2", 2, 1, 0, _SCORE_A)],
        {"tempo": _TEMPO_CURVE, "dynamics": _DYN_CURVE,
         "articulation": [[0, 0.8, 6.0], [1440, 1.1, -4.0]],
         "movement": [[0, 0.1, 0.9, 0.3, 0.0, "sustain"],
                      [2880, 0.9, None, None, None, "sustain"]]},
        [("P1", 1, 0, 0, {"tempo": None, "dynamics": None, "movement": None,
                          "articulation": None, "rubato": None, "asynchrony": None}),
         ("P2", 2, 1, 0, {})])

    add("global_movement_both_parts",
        "a GLOBAL movementMap renders a positionMap into EVERY part (Performance loops "
        "per part), each with that part's own asynchrony offset",
        [("P1", 1, 0, 0, _SCORE_A), ("P2", 2, 1, 0, _SCORE_B)],
        {"tempo": _TEMPO_CURVE,
         "movement": [[0, 0.0, 1.0, 0.4, 0.0, "sustain"],
                      [2880, 1.0, None, None, None, "sustain"]],
         "asynchrony": [[0, 5.0]]},
        [("P1", 1, 0, 0, {}), ("P2", 2, 1, 0, {"asynchrony": [[0, -40.0]]})])

    return cases


def _assert_java_default_max_step(cases):
    """``MovementMap.movementSampleMaxStep`` is a **static** field and ``RenderMpm`` has no
    hook to assign it, so every Java-side render happens at meico's own 0.1 default. A case
    whose Python side used a different step would be comparing two different curves; the
    symptom (differing point counts) would be loud but the cause would not, so refuse it up
    front. The espressivo leg has no such limit -- it passes the value through
    ``RenderOptions.movementSampleMaxStep`` -- which is why the field is a per-case one.
    """
    bad = [name for name, _n, _m, _p, (_g, _ps, step) in cases
           if step is not None and step != DEFAULT_MOVEMENT_SAMPLE_MAX_STEP]
    if bad:
        raise SystemExit(
            "java mode cannot honour a non-default movementSampleMaxStep (%s is a static "
            "field in MovementMap and RenderMpm never assigns it), but these cases request "
            "one: %s. Either drop the value or extend RenderMpm."
            % (DEFAULT_MOVEMENT_SAMPLE_MAX_STEP, ", ".join(bad)))


def _run_java(cases, workdir, verbose=False):
    """Write every case out, render them all in one JVM, return {name: augmented_xml}."""
    _assert_java_default_max_step(cases)
    if not os.path.exists(os.path.join(JAVA_OUT, "RenderMpm.class")):
        raise SystemExit("RenderMpm.class not found in %s -- compile it first:\n"
                         "  javac -cp \"%s\" -d %s %s"
                         % (JAVA_OUT, CLASSPATH, JAVA_OUT,
                            os.path.join(ML, "java", "RenderMpm.java")))
    manifest = os.path.join(workdir, "manifest.tsv")
    with open(manifest, "w") as mf:
        for name, _note, msm, mpm, _spec in cases:
            p_msm = os.path.join(workdir, name + ".msm")
            p_mpm = os.path.join(workdir, name + ".mpm")
            p_out = os.path.join(workdir, name + "_augmented.msm")
            with open(p_msm, "w") as f:
                f.write(msm)
            with open(p_mpm, "w") as f:
                f.write(mpm)
            mf.write("%s\t%s\t%s\n" % (p_msm, p_mpm, p_out))
    proc = subprocess.run(["nice", "-n", "15", "java", "-cp", CLASSPATH,
                           "RenderMpm", "--batch", manifest],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stdout[-4000:])
        print(proc.stderr[-4000:], file=sys.stderr)
        raise SystemExit("RenderMpm --batch failed with rc=%d" % proc.returncode)
    if verbose:
        print(proc.stdout.strip()[-2000:])
    out = {}
    for name, _note, _msm, _mpm, _spec in cases:
        with open(os.path.join(workdir, name + "_augmented.msm")) as f:
            out[name] = f.read()
    return out


def _fnum(e, attr):
    v = e.get(attr)
    return None if v is None else float(v)


def _parse_augmented(xml_text):
    """{part_number: {"notes": [...], "positions": [...], "volumes": [...]}} from an MSM."""
    root = ET.fromstring(xml_text)
    parts = {}
    for pi, part in enumerate(root.findall("part")):
        dated = part.find("dated")
        rec = {"index": pi, "name": part.get("name"),
               "notes": [], "positions": [], "volumes": []}
        score = dated.find("score") if dated is not None else None
        if score is not None:
            for n in score.findall("note"):
                rec["notes"].append({
                    "id": n.get(XML_ID), "date": _fnum(n, "date"),
                    "duration": _fnum(n, "duration"),
                    "velocity": _fnum(n, "velocity"),
                    "ms_on": _fnum(n, "milliseconds.date"),
                    "ms_off": _fnum(n, "milliseconds.date.end")})
        pm = dated.find("positionMap") if dated is not None else None
        if pm is not None:
            for p in pm.findall("position"):
                rec["positions"].append({"date": _fnum(p, "date"),
                                         "value": _fnum(p, "value"),
                                         "controller": p.get("controller"),
                                         "ms": _fnum(p, "milliseconds.date")})
        cv = dated.find("channelVolumeMap") if dated is not None else None
        if cv is not None:
            for v in cv.findall("volume"):
                rec["volumes"].append({"date": _fnum(v, "date"),
                                       "value": _fnum(v, "value"),
                                       "ms": _fnum(v, "milliseconds.date")})
        parts[int(float(part.get("number")))] = rec
    return parts


def _js_round(x):
    """ECMAScript ``Math.round`` -- ``floor(x + 0.5)``, not Python's banker's ``round``.

    ``generate_v4.mjs:406`` records the **MIDI observable** ``Math.round(value)`` rather than
    the raw positionMap double (its rationale: ``Msm.parsePositionMap`` emits the integer into
    MIDI, and the Vienna corpus carries integers under the same key -- 0/3385 non-integer
    values -- so a synthetic pedal model must not learn a value distribution real data cannot
    produce). Reproducing the ground truth therefore means reproducing this rounding exactly.
    Python's ``round`` would differ on every exact ``.5``: ``round(0.5) == 0``.
    """
    if x != x or x in (float("inf"), float("-inf")):
        return x
    return float(math.floor(x + 0.5))


def _compare_cc(got, exp, where_prefix, diffs, errors, round_value=False):
    """Bit-compare two control-change point lists element-wise. Returns #compared.

    ``round_value`` compares the MIDI observable ``Math.round(value)`` instead of the raw
    double -- the encoding the ground truth is in, not a tolerance: the comparison is still
    on the exact bit pattern, of a value the port computes rather than reads.
    """
    if len(got) != len(exp):
        errors.append("%s: %d events vs %d rendered" % (where_prefix, len(got), len(exp)))
    n = 0
    for i, (g, e) in enumerate(zip(got, exp)):
        where = "%s%d" % (where_prefix, i)
        diffs.add("cc_ms", g.ms, e["ms"], where)
        diffs.add("cc_value", _js_round(g.value) if round_value else g.value,
                  e["value"], where)
        if e.get("date") is not None and not _bit_identical(g.date, e["date"]):
            errors.append("%s: date %r vs %r" % (where, g.date, e["date"]))
        if e.get("controller") is not None and g.controller != e["controller"]:
            errors.append("%s: controller %r vs %r" % (where, g.controller,
                                                       e["controller"]))
        n += 1
    return n


def _check_stream_partition(part, where):
    """The grouped ``cc`` view must be a stable partition of the flat maps (espressivo's
    ``readControlChanges``): same points, same relative order inside each controller."""
    errors = []
    grouped = [p for s in part.cc if s.kind == "position" for p in s.points]
    if len(grouped) != len(part.positions):
        errors.append("%s: %d grouped position points vs %d flat"
                      % (where, len(grouped), len(part.positions)))
        return errors
    for s in part.cc:
        if s.kind != "position":
            continue
        if s.cc_number != {"sustain": 64, "soft": 67}.get(s.controller, 0):
            errors.append("%s: stream %r has cc_number %d" % (where, s.controller,
                                                              s.cc_number))
        expect = [p for p in part.positions if p.controller == s.controller]
        if [id(p) for p in s.points] != [id(p) for p in expect]:
            errors.append("%s: stream %r is not a stable slice of the flat positionMap"
                          % (where, s.controller))
    return errors


def _compare_cases(cases, rendered):
    """Render every case with the Python chain and bit-compare against the fork's output.

    Returns ``(ok, notes_diffs, cc_diffs, errors, counts, stats, per_case_ok)``.
    """
    notes_d = Diffs(["ms_on", "ms_off", "velocity"])
    cc_d = Diffs(["cc_ms", "cc_value"])
    counts = {"cases": 0, "parts": 0, "notes": 0, "positions": 0, "volumes": 0}
    errors = []
    agg_stats = {}
    per_case_ok = {}

    for name, _note, _msm, _mpm, (gmaps, pspecs, max_step) in cases:
        before = (sum(notes_d.neq.values()) + sum(cc_d.neq.values())
                  + notes_d.missing + cc_d.missing, len(errors))
        ref = _parse_augmented(rendered[name])
        try:
            chain = PerfChainV4(pspecs, global_maps=gmaps,
                                movement_sample_max_step=max_step)
            got_parts = chain.render()
        except Exception as exc:                                # noqa: BLE001
            errors.append("%s: port raised %s: %s" % (name, type(exc).__name__, exc))
            per_case_ok[name] = False
            continue
        for k, v in chain.stats.items():
            agg_stats[k] = agg_stats.get(k, 0) + v
        counts["cases"] += 1

        for pp in got_parts:
            r = ref.get(pp.number)
            if r is None:
                errors.append("%s: no rendered part number %s" % (name, pp.number))
                continue
            counts["parts"] += 1

            if len(pp.notes) != len(r["notes"]):
                errors.append("%s/p%s: %d notes vs %d rendered"
                              % (name, pp.number, len(pp.notes), len(r["notes"])))
            for i, (g, e) in enumerate(zip(pp.notes, r["notes"])):
                where = "%s/p%s/n%d" % (name, pp.number, i)
                notes_d.add("ms_on", g.ms_on, e["ms_on"], where)
                notes_d.add("ms_off", g.ms_off, e["ms_off"], where)
                notes_d.add("velocity", g.velocity, e["velocity"], where)
                counts["notes"] += 1

            # control changes: the flat, map-order positionMap is the ground truth
            counts["positions"] += _compare_cc(pp.positions, r["positions"],
                                               "%s/p%s/pos" % (name, pp.number),
                                               cc_d, errors)
            counts["volumes"] += _compare_cc(pp.volumes, r["volumes"],
                                             "%s/p%s/cv" % (name, pp.number),
                                             cc_d, errors)
            errors.extend(_check_stream_partition(pp, "%s/p%s" % (name, pp.number)))

        after = (sum(notes_d.neq.values()) + sum(cc_d.neq.values())
                 + notes_d.missing + cc_d.missing, len(errors))
        per_case_ok[name] = (after == before)

    ok = (notes_d.ok() and cc_d.ok() and not errors
          and counts["notes"] > 0 and counts["positions"] > 0)
    return ok, notes_d, cc_d, errors, counts, agg_stats, per_case_ok


# =======================================================================================
#  ESPRESSIVO CROSS-CHECK -- the same cases through the TypeScript renderer
# =======================================================================================

ESPRESSIVO = os.environ.get("ESPRESSIVO", "/Users/nielspfeffer/Projects/meico-ts")

_ESPRESSIVO_DRIVER = r"""
const fs = require('fs');
const api = require(process.argv[2] + '/dist/api/index.js');
const jobs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const out = {};
for (const job of jobs) {
  const opts = {};
  if (job.maxStep !== null) opts.movementSampleMaxStep = job.maxStep;
  const data = api.performMsmToData({
    msm: fs.readFileSync(job.msm, 'utf8'),
    mpm: fs.readFileSync(job.mpm, 'utf8'),
  }, opts);
  out[job.name] = data.parts.map((p) => ({
    name: p.name,
    notes: p.notes.map((n) => [n.milliseconds.date, n.milliseconds.end, n.velocity]),
    cc: p.controlChanges.map((s) => ({
      kind: s.kind, controller: s.controller, ccNumber: s.ccNumber,
      points: s.points.map((q) => [q.date, q.milliseconds, q.value]),
    })),
  }));
}
fs.writeFileSync(process.argv[4], JSON.stringify(out));
"""


# Three things make some espressivo fields incomparable. Two are RENDERER defects and are the
# SAME BUG CLASS as the three movementMap parsing bugs the Java fork fixed on 2026-08-08: a
# ``get<Map>DataOf`` that builds a fresh data object and forgets to copy the XML attributes
# into it, so the renderer silently uses the field initialisers. Both re-verified present at
# meico-ts@415bbd2 (ArticulationMap.ts:103-121, DynamicsMap.ts:100-128); the intervening
# T16/T21/TD2 refactors moved the code but not the omission. The third ("velabsent") is not a
# renderer divergence at all but a lossy field in the frozen facade. None of them touches
# movement or asynchrony, which stay bit-identical across all three implementations here --
# including across TD2's MovementMap.ts rewrite, which this battery re-passes unchanged.
#
# Provenance is per-RUN, not per-commit: the espressivo leg tests ``dist/api/index.js`` as
# built at the moment it runs. Print ``ls -lT $ESPRESSIVO/dist/api/index.js`` alongside any
# result that is meant to be cited later.
ESPRESSIVO_BUGS = {
    "artic": ("""\
espressivo ignores LITERAL ARTICULATION attributes (affects velocity and ms_off).
`ArticulationMap.getArticulationDataOf` (meico-ts src/mpm/elements/maps/ArticulationMap.ts)
builds `new ArticulationData()` and fills only xml/date/xmlId/noteid/style/name.ref -- it
never parses the 13 numeric modifier attributes that the fork's
`ArticulationMap.java:getArticulationDataOf` parses inline. (ArticulationData's own XML
constructor DOES parse them; the map never calls it.) So a literal `relativeDuration` /
`absoluteVelocityChange` is a silent NO-OP there, while the styleDef `name.ref` spelling
renders identically in both.
  repro: 3 notes @100bpm, volume 60, `<articulation date="0" relativeDuration="0.5"
  absoluteVelocityChange="12"/>` -> fork velocity 72.0 / duration.perf 360.0 (ms end 300);
  espressivo velocity 60 / ms end 600. The same articulation as
  `<articulationDef name="stac" relativeDuration="0.5" absoluteVelocityChange="12"/>` +
  `<style name.ref>` + `<articulation name.ref="stac"/>` gives 72 / 300 in BOTH."""),
    "dyncurve": ("""\
espressivo ignores DYNAMICS `curvature` / `protraction` (affects velocity).
`DynamicsMap.getDynamicsDataOf` (meico-ts src/mpm/elements/maps/DynamicsMap.ts) parses
volume, transition.to and subNoteDynamics but never curvature/protraction, so they stay
null and `computeInnerControlPointsXPositions` defaults them to 0.0 -- every continuous
dynamics transition is rendered with x1=0, x2=1 regardless of the XML. The fork parses them
AND clamps them (`ensureCurvatureBoundaries` / `ensureProtractionBoundaries`,
DynamicsMap.java), so a port also needs the clamp.
  repro: `<dynamics date="1440" volume="60" transition.to="100" curvature="0.3"
  protraction="-0.4"/>`, note at tick 2160 (the exact midpoint) -> fork velocity
  88.53760540485382, espressivo 80 (= the t=0.5 identity-curve value)."""),
    "velabsent": ("""\
espressivo's FACADE cannot express an ABSENT velocity (affects velocity only).
This one is NOT a renderer divergence: `DynamicsMap.renderDynamicsToMap` (meico-ts
src/mpm/elements/maps/DynamicsMap.ts:159) mirrors the fork's D0 short-circuit exactly
(`if (map === null || this.elements.length === 0) return null;`), so with an empty but
present <dynamicsMap/> the TS renderer, the Java fork and this port all leave the note
without a `velocity` attribute. The loss happens one layer up, in the frozen facade:
`readNote` (src/api/pipeline.ts:250) returns `optionalNumber('velocity', note) ?? 100`,
a documented unperformed-note fallback (their RULE E3). A consumer of `performMsmToData`
therefore cannot tell "no velocity attribute" from "velocity 100.0".
  repro: part-local `<dynamicsMap/>` (empty) + a global articulationMap -> fork writes no
  velocity attribute and drops absoluteVelocityChange (ArticulationData.java:209); the facade
  reports velocity 100 for every note.
  consequence for us: a v4 generator built on the facade would record a velocity meico never
  wrote. Harmless while CANONICAL.md never emits an empty map element -- which is exactly why
  it must stay that way, or the facade needs `velocity: number | null`."""),
}

ESPRESSIVO_IMPACT = """\
IMPACT ON THE PROGRAM: CANONICAL.md G5 pins the canonical form to literal values with no
styleDef indirection, and the sampler draws dynamics curvature in [0, 0.9] and protraction
in [-0.7, 0.7] (CANONICAL.md sec.3). So espressivo would mis-render v2, v3 AND v4 training
data -- every articulation as a no-op and every dynamics transition with the wrong shape.
That is a blocker for LOG.md's "the v4 generator migrates to meico-ts" decision until both
are fixed there. The earlier T13 cross-renderer smoke test did not catch it because it ran
on the movement fixture, which has neither literal articulation nor a curved dynamics
transition.

AND IT IS THE DEFAULT: ml/node/generate_v4.mjs:159 sets `renderer: 'espressivo'`; `--renderer
java` must be asked for explicitly, and requesting articulation or dynamics only prints a
WARNING to stderr (generate_v4.mjs:366-370). An out-of-the-box generator invocation therefore
produces defective supervision -- articulation as the identity, every dynamics curve as the
straight line. Until espressivo is fixed, `--renderer java` should be the DEFAULT rather than
the documented escape hatch (Team D's file, not this one)."""


def _espressivo_quarantine(gmaps, pspecs):
    """Which fields of this case espressivo cannot be held to. Returns {field: reason}."""
    out = {}
    for spec in pspecs:
        # D0: an empty but PRESENT local dynamicsMap leaves the note without a velocity
        # attribute, which the facade's `?? 100` fallback cannot report.
        if isinstance(spec.get("dynamics"), list) and not spec["dynamics"]:
            out["velocity"] = "velabsent"
    for src in [gmaps] + list(pspecs):
        for row in (src.get("articulation") or []):
            if (len(row) > 1 and row[1] != 1.0) or (len(row) > 2 and row[2] != 0.0):
                out.setdefault("velocity", "artic")     # velabsent, above, is stricter
                out["ms_off"] = "artic"
        for row in (src.get("dynamics") or []):
            if len(row) > 2 and row[2] is not None and (
                    (len(row) > 3 and row[3]) or (len(row) > 4 and row[4])):
                out.setdefault("velocity", "dyncurve")
    return out


def espressivo_mode(verbose=False, keep=False):
    """Render the same battery with espressivo and require Python == TS bit for bit.

    The Java fork is the primary reference; this is the third leg of the triangle, and it
    exercises espressivo's own grouped ``controlChanges`` shape (which ``PartPerf.cc``
    mirrors) rather than the flat MSM positionMap.

    Cases that use literal articulation attributes are compared but *quarantined* from the
    verdict, because espressivo does not implement them (:data:`ESPRESSIVO_ARTIC_BUG`);
    their control-change and onset values are still required to be exact, since the bug
    cannot touch those.
    """
    if not os.path.exists(os.path.join(ESPRESSIVO, "dist", "api", "index.js")):
        print("espressivo build not found at %s/dist/api/index.js -- skipping"
              % ESPRESSIVO)
        return 0

    cases = _cases()
    workdir = tempfile.mkdtemp(prefix="validate_v4_ts_",
                               dir=os.environ.get("TMPDIR") or None)
    try:
        jobs = []
        for name, _note, msm, mpm, (_g, _p, max_step) in cases:
            p_msm = os.path.join(workdir, name + ".msm")
            p_mpm = os.path.join(workdir, name + ".mpm")
            with open(p_msm, "w") as f:
                f.write(msm)
            with open(p_mpm, "w") as f:
                f.write(mpm)
            jobs.append({"name": name, "msm": p_msm, "mpm": p_mpm, "maxStep": max_step})
        p_jobs = os.path.join(workdir, "jobs.json")
        p_driver = os.path.join(workdir, "driver.cjs")
        p_out = os.path.join(workdir, "out.json")
        with open(p_jobs, "w") as f:
            json.dump(jobs, f)
        with open(p_driver, "w") as f:
            f.write(_ESPRESSIVO_DRIVER)
        proc = subprocess.run(["nice", "-n", "15", "node", p_driver, ESPRESSIVO,
                               p_jobs, p_out], capture_output=True, text=True)
        if proc.returncode != 0:
            print(proc.stdout[-3000:])
            print(proc.stderr[-3000:], file=sys.stderr)
            raise SystemExit("espressivo driver failed with rc=%d" % proc.returncode)
        if verbose and proc.stdout.strip():
            print(proc.stdout.strip()[-1500:])
        with open(p_out) as f:
            ts = json.load(f)

        notes_d = Diffs(["ms_on", "ms_off", "velocity"])
        cc_d = Diffs(["cc_ms", "cc_value"])
        quarantine = Diffs(["ms_off", "velocity"])
        errors = []
        n_notes = n_cc = n_streams = 0
        quarantined = []

        for name, _note, _msm, _mpm, (gmaps, pspecs, max_step) in cases:
            got_parts = PerfChainV4(pspecs, global_maps=gmaps,
                                    movement_sample_max_step=max_step).render()
            ts_parts = ts[name]
            qfields = _espressivo_quarantine(gmaps, pspecs)
            if qfields:
                quarantined.append((name, dict(qfields)))
            if len(got_parts) != len(ts_parts):
                errors.append("%s: %d parts vs %d from espressivo"
                              % (name, len(got_parts), len(ts_parts)))
            for pp, tp in zip(got_parts, ts_parts):
                if len(pp.notes) != len(tp["notes"]):
                    errors.append("%s/%s: %d notes vs %d"
                                  % (name, tp["name"], len(pp.notes), len(tp["notes"])))
                for i, (g, e) in enumerate(zip(pp.notes, tp["notes"])):
                    where = "%s/%s/n%d" % (name, tp["name"], i)
                    # ms_on can never be touched by either defect (articulation moves no
                    # onset under CANONICAL.md H3/A5, dynamics moves nothing at all), so it
                    # always stays in the verdict.
                    notes_d.add("ms_on", g.ms_on, e[0], where)
                    (quarantine if "ms_off" in qfields else notes_d).add(
                        "ms_off", g.ms_off, e[1], where)
                    (quarantine if "velocity" in qfields else notes_d).add(
                        "velocity", g.velocity, e[2], where)
                    n_notes += 1
                # espressivo returns the GROUPED streams; PartPerf.cc must match 1:1
                if len(pp.cc) != len(tp["cc"]):
                    errors.append("%s/%s: %d cc streams vs %d (%s vs %s)"
                                  % (name, tp["name"], len(pp.cc), len(tp["cc"]),
                                     [s.controller for s in pp.cc],
                                     [s["controller"] for s in tp["cc"]]))
                for s, t in zip(pp.cc, tp["cc"]):
                    n_streams += 1
                    if (s.kind, s.controller, s.cc_number) != (t["kind"], t["controller"],
                                                               t["ccNumber"]):
                        errors.append("%s/%s: stream (%s,%s,%d) vs (%s,%s,%d)"
                                      % (name, tp["name"], s.kind, s.controller,
                                         s.cc_number, t["kind"], t["controller"],
                                         t["ccNumber"]))
                    if len(s.points) != len(t["points"]):
                        errors.append("%s/%s/%s: %d points vs %d"
                                      % (name, tp["name"], s.controller, len(s.points),
                                         len(t["points"])))
                    for i, (g, e) in enumerate(zip(s.points, t["points"])):
                        where = "%s/%s/%s/%d" % (name, tp["name"], s.controller, i)
                        if not _bit_identical(g.date, e[0]):
                            errors.append("%s: date %r vs %r" % (where, g.date, e[0]))
                        cc_d.add("cc_ms", g.ms, e[1], where)
                        cc_d.add("cc_value", g.value, e[2], where)
                        n_cc += 1

        print("espressivo cross-check (%s): %d cases, %d notes, %d cc streams, "
              "%d cc points" % (os.path.basename(ESPRESSIVO), len(cases), n_notes,
                                n_streams, n_cc))
        notes_d.report()
        cc_d.report()
        if errors:
            print("  SHAPE ERRORS (%d):" % len(errors))
            for m in errors[:20]:
                print("    " + m)
        if verbose:
            notes_d.report_worst()
            cc_d.report_worst()
        ok = notes_d.ok() and cc_d.ok() and not errors and n_notes > 0 and n_cc > 0
        print("EXACT" if ok else "MISMATCH")

        if quarantined:
            reasons = {}
            for cname, qf in quarantined:
                for field, why in qf.items():
                    reasons.setdefault(why, set()).add(cname)
            print("\n  QUARANTINED from the verdict -- known espressivo defects, %d cases:"
                  % len(quarantined))
            for why in sorted(reasons):
                print("    [%s] %s" % (why, ", ".join(sorted(reasons[why]))))
            quarantine.report("    ")
            if quarantine.ok():
                print("    ... no divergence after all -- the upstream defects may be "
                      "fixed; fold these fields back into the verdict")
            else:
                for why in sorted(reasons):
                    print()
                    for line in ESPRESSIVO_BUGS[why].splitlines():
                        print("    " + line)
                print()
                for line in ESPRESSIVO_IMPACT.splitlines():
                    print("    " + line)
        return 0 if ok else 1
    finally:
        if keep:
            print("kept: %s" % workdir)
        else:
            shutil.rmtree(workdir, ignore_errors=True)


def java_mode(verbose=False, keep=False, list_only=False, negative=False,
              espressivo_too=False):
    cases = _cases()
    if list_only:
        print("%d cases:" % len(cases))
        for name, note, _m, _p, _s in cases:
            print("  %-28s %s" % (name, note))
        print("\n%d negative controls:" % len(NEGATIVE_CONTROLS))
        for nname, nnote, _fn in NEGATIVE_CONTROLS:
            print("  %-28s %s" % (nname, nnote))
        return 0

    workdir = tempfile.mkdtemp(prefix="validate_v4_",
                               dir=os.environ.get("TMPDIR") or None)
    try:
        rendered = _run_java(cases, workdir, verbose=verbose)
        ok, notes_d, cc_d, errors, counts, agg_stats, _ = _compare_cases(cases, rendered)

        print("java mode: %d cases, %d parts, %d notes, %d position events, "
              "%d channelVolume events"
              % (counts["cases"], counts["parts"], counts["notes"], counts["positions"],
                 counts["volumes"]))
        print("  meico order-dependent paths exercised: "
              + "  ".join("%s=%d" % (k, agg_stats[k]) for k in sorted(agg_stats)
                          if agg_stats[k]))
        notes_d.report()
        cc_d.report()
        if errors:
            print("  SHAPE ERRORS (%d):" % len(errors))
            for m in errors[:20]:
                print("    " + m)
        if verbose:
            notes_d.report_worst()
            cc_d.report_worst()
        print("EXACT" if ok else "MISMATCH")

        if negative:
            ok = _negative_controls(cases, rendered) and ok
        if espressivo_too:
            print()
            ok = (espressivo_mode(verbose=verbose, keep=keep) == 0) and ok
        return 0 if ok else 1
    finally:
        if keep:
            print("kept: %s" % workdir)
        else:
            shutil.rmtree(workdir, ignore_errors=True)


# =======================================================================================
#  NEGATIVE CONTROLS -- proof that the battery discriminates
# =======================================================================================
#
# A green validator is only evidence if a WRONG port would turn it red. Each control below
# monkey-patches one plausible alternative reading of the reference -- the "obvious correct"
# version of a quirk, or a semantics an implementer would naturally reach for -- and the
# battery must go MISMATCH, on at least the cases named. A control that stays EXACT means
# that behaviour is NOT under test and the case battery has a hole.

def _nc_previous_position_from_zero():
    """Q2 fixed: scan down to index 0 instead of stopping at j > 0."""
    import movement_math as mm

    def patched(self, index):
        final_position = 0.0
        for j in range(index - 1, -1, -1):
            tt = self.instrs[j][mm.MOV_TRANSITION_TO]
            if tt is None:
                raise ValueError("no transition.to on row %d" % j)
            final_position = float(tt)
            break
        return final_position
    return mm.MovementTimeline, "previous_position", patched


def _nc_default_curvature_zero():
    """Q6 ignored: default curvature 0.0 (a straight line) instead of the field's 0.4."""
    import movement_math as mm
    return mm, "DEFAULT_CURVATURE", 0.0


def _nc_render_last_movement():
    """Q1 ignored: render the final movement instruction too."""
    import movement_math as mm

    def patched(self, max_step_size=mm.DEFAULT_MOVEMENT_SAMPLE_MAX_STEP):
        out = []
        for i in range(len(self.instrs)):
            md = self.movement_data_of(i)
            if md is None or md.start_date < 0:
                continue
            for date, value in md.get_movement_segment(max_step_size):
                mm._insert_element(out, mm.PositionEvent(date, value, md.controller))
        return out
    return mm.MovementTimeline, "render_to_position_map", patched


def _nc_no_bracket_points():
    """Q3 ignored: no prepended start / appended end -> no duplicated endpoints."""
    import movement_math as mm

    def patched(self, max_step_size=mm.DEFAULT_MOVEMENT_SAMPLE_MAX_STEP):
        if self.x1 is None:
            self._compute_inner_control_points()
        ts = [0.0, 1.0]
        series = [self.date_position(0.0), self.date_position(1.0)]
        i = 0
        while i < len(ts) - 1:
            while abs(series[i + 1][1] - series[i][1]) > max_step_size:
                t = (ts[i] + ts[i + 1]) * 0.5
                ts.insert(i + 1, t)
                series.insert(i + 1, self.date_position(t))
            i += 1
        for tup in series:
            tup[1] *= 127
        return series
    return mm.MovementData, "get_movement_segment", patched


def _nc_max_step_in_127_domain():
    """meico-ts' "16129 bug": compare the subdivision threshold after the x127 scaling."""
    import movement_math as mm

    def patched(self, max_step_size=mm.DEFAULT_MOVEMENT_SAMPLE_MAX_STEP):
        if self.x1 is None:
            self._compute_inner_control_points()
        ts = [0.0, 1.0]
        series = [self.date_position(0.0), self.date_position(1.0)]
        i = 0
        while i < len(ts) - 1:
            while abs(series[i + 1][1] * 127 - series[i][1] * 127) > max_step_size:
                t = (ts[i] + ts[i + 1]) * 0.5
                ts.insert(i + 1, t)
                series.insert(i + 1, self.date_position(t))
            i += 1
        series.insert(0, [self.start_date, self.position])
        if self.transition_to is not None:
            series.append([self.end_date, self.transition_to])
        for tup in series:
            tup[1] *= 127
        return series
    return mm.MovementData, "get_movement_segment", patched


def _nc_asyn_end_floor_from_own_start():
    """A2 ignored: floor the end at the note's OWN shifted start rather than the per-pair
    local 0.0, i.e. carry startDateMs across asynchrony instructions."""
    import asynchrony_math as am

    def patched(self, entries):
        self.stats = {"carried": 0, "start_shifted": 0, "end_shifted": 0,
                      "start_clamped": 0, "end_clamped": 0}
        if not self.instrs:
            return
        map_entries = list(entries)
        done = []
        n_instr = len(self.instrs)
        for ai in range(n_instr):
            asyn_date = self.instrs[ai][am.ASY_DATE]
            asyn_end = (self.instrs[ai + 1][am.ASY_DATE] if ai < n_instr - 1
                        else 1.7976931348623157e308)
            offset = self.instrs[ai][am.ASY_OFFSET]
            for entry in map_entries:
                if entry.key >= asyn_end:
                    break
                if entry.key >= asyn_date and entry.ms_date is not None:
                    entry.ms_date = am.java_max(0.0, entry.ms_date + offset)
                start_date_ms = entry.ms_date if entry.ms_date is not None else 0.0
                if entry.duration is None:
                    done.append(entry)
                    continue
                end = entry.duration + entry.key
                if end >= asyn_end:
                    self.stats["carried"] += 1
                    continue
                if end >= asyn_date and entry.ms_end is not None:
                    entry.ms_end = am.java_max(entry.ms_end + offset, start_date_ms + 1)
                done.append(entry)
            for r in done:
                map_entries.remove(r)
            done.clear()
    return am.AsynchronyTimeline, "render", patched


def _nc_asyn_membership_from_perf_end():
    """Segment membership from the PERFORMED end (date.end.perf, i.e. after articulation
    and rubato) instead of the raw tick ``duration + date``."""
    import asynchrony_math as am
    original = am.AsynchronyTimeline.render

    def patched(self, entries):
        saved = [e.duration for e in entries]
        for e in entries:
            if e.duration is not None and e.payload is not None:
                perf_end = getattr(e.payload, "date_end_perf", None)
                if perf_end is not None:
                    e.duration = perf_end - e.key
        try:
            original(self, entries)
        finally:
            for e, d in zip(entries, saved):
                e.duration = d
    return am.AsynchronyTimeline, "render", patched


def _nc_artic_exact_date():
    """A6 ignored: match articulations by exact date, as ``PerfChain`` does -- correct for
    every v3 dataset, wrong as soon as an articulation date carries no note in this part."""
    import perf_chain_v4 as pc4
    from perf_chain import PerfChain
    return pc4._ScoreChain, "_apply_articulation", PerfChain._apply_articulation


def _nc_artic_offdate_whole_chord():
    """A6 half-ignored: an off-date articulation spills over the WHOLE chord it lands on,
    i.e. the neighbour guard compares against the found note's date instead of the
    requested one."""
    import perf_chain_v4 as pc4

    def patched(self, notes):
        if not self.articulation:
            return
        dates = [n.date for n in notes]
        per_note = {}
        for a in self.articulation:
            idx = pc4._index_at_after(dates, a[0])
            if idx < 0:
                continue
            targets = [idx]
            j = idx + 1
            while j < len(dates) and dates[j] == dates[idx]:        # <- the mutation
                targets.append(j)
                j += 1
            for t in targets:
                per_note.setdefault(t, []).append(a)
        for t in sorted(per_note):
            note = notes[t]
            for a in per_note[t]:
                if a[1] != 1.0:
                    note.duration_perf = note.duration_perf * a[1]
                if a[2] != 0.0:
                    note.velocity = note.velocity + a[2]
    return pc4._ScoreChain, "_apply_articulation", patched


def _nc_empty_dynamics_velocity_100():
    """D0 ignored: an empty-but-present dynamicsMap defaults every velocity to 100.0 (what
    ``PerfChain`` does, and what collapsing ``None`` and ``[]`` onto each other gives)."""
    import perf_chain_v4 as pc4
    from perf_chain import PerfChain

    def patched(self, notes):
        PerfChain._apply_dynamics(self, notes)
    return pc4._ScoreChain, "_apply_dynamics", patched


def _nc_no_dynamics_clamp():
    """D1 ignored: dynamics curvature/protraction used verbatim, unclamped -- what
    ``dynamics_math.inner_control_points`` does on its own."""
    import perf_chain_v4 as pc4

    def patched(rows):
        return [list(r) for r in rows], 0
    return pc4, "_clamped_dynamics", patched


def _nc_local_none_is_null_map():
    """The pre-fix ``_resolve``: an explicit ``None`` local map is a *null* map that shadows
    the global one, instead of inheriting it (``Performance.java:479-494`` says inherit)."""
    import perf_chain_v4 as pc4

    def patched(self, part):
        out = {}
        for k in pc4.MAP_KEYS:
            v = part.get(k, pc4.INHERIT)
            out[k] = (self.global_maps.get(k) if isinstance(v, pc4._Inherit) else v)
        return out
    return pc4.PerfChainV4, "_resolve", patched


NEGATIVE_CONTROLS = [
    ("nc_prev_position_j0", "Q2 'fixed': getPreviousPosition scans down to index 0",
     _nc_previous_position_from_zero),
    ("nc_default_curvature0", "Q6 ignored: default curvature 0.0 instead of 0.4",
     _nc_default_curvature_zero),
    ("nc_render_last_movement", "Q1 ignored: the final movement instruction is rendered",
     _nc_render_last_movement),
    ("nc_no_bracket_points", "Q3 ignored: no prepended/appended exact endpoints",
     _nc_no_bracket_points),
    ("nc_maxstep_127", "maxStepSize compared in the 0..127 domain (the 16129 bug)",
     _nc_max_step_in_127_domain),
    ("nc_asyn_end_floor", "A2 ignored: end floored at the note's own shifted start",
     _nc_asyn_end_floor_from_own_start),
    ("nc_asyn_perf_end", "asynchrony segment membership from date.end.perf, not ticks",
     _nc_asyn_membership_from_perf_end),
    ("nc_artic_exact_date", "A6 ignored: articulations matched by exact date (PerfChain)",
     _nc_artic_exact_date),
    ("nc_artic_whole_chord", "A6 half-ignored: off-date articulation spills over the chord",
     _nc_artic_offdate_whole_chord),
    ("nc_empty_dyn_vel100", "D0 ignored: an empty dynamicsMap defaults velocity to 100.0",
     _nc_empty_dynamics_velocity_100),
    ("nc_no_dyn_clamp", "D1 ignored: dynamics curvature/protraction not clamped at render",
     _nc_no_dynamics_clamp),
    ("nc_local_none_shadows", "map resolution: a local `None` map shadows instead of "
     "inheriting", _nc_local_none_is_null_map),
]


def _negative_controls(cases, rendered):
    print("\nnegative controls (each MUST turn the battery MISMATCH):")
    all_ok = True
    for name, note, factory in NEGATIVE_CONTROLS:
        target, attr, patch = factory()
        saved = getattr(target, attr)
        try:
            setattr(target, attr, patch)
            ok, notes_d, cc_d, errors, counts, _stats, per_case = _compare_cases(
                cases, rendered)
        finally:
            setattr(target, attr, saved)
        broken = sorted(n for n, good in per_case.items() if not good)
        bad_values = sum(notes_d.neq.values()) + sum(cc_d.neq.values())
        status = "DETECTED" if not ok else "NOT DETECTED  <-- battery hole"
        all_ok = all_ok and (not ok)
        print("  %-24s %-9s %d/%d cases differ, %d non-bit-identical values, "
              "%d shape errors"
              % (name, status, len(broken), len(cases), bad_values, len(errors)))
        print("      %s" % note)
        if broken:
            print("      first differing cases: %s" % ", ".join(broken[:4]))
    print("negative controls: %s" % ("ALL DETECTED" if all_ok else "INCOMPLETE"))
    return all_ok


# =======================================================================================
#  PILOT MODE -- Team D's JSONL
# =======================================================================================

MAP_FIELDS = ("tempo", "dynamics", "articulation", "rubato", "movement", "asynchrony")

#: Control-change ground truth may be keyed by controller (``sustain_cc`` / ``soft_cc``,
#: the v4 generator's and the Vienna adapter's spelling) or as one flat list.
_CC_KEYS_BY_CONTROLLER = {"sustain_cc": "sustain", "soft_cc": "soft"}
_CC_KEYS_FLAT = ("positions", "position_map", "positionMap", "cc", "control_changes",
                 "controlChanges", "movement_cc", "pedal")


def _cc_rows(rows):
    """Normalise CC ground-truth rows to dicts. Accepts ``[ms, value]``,
    ``[date, ms, value]``, ``[date, ms, value, controller]`` and dicts."""
    out = []
    for row in rows:
        if isinstance(row, dict):
            out.append({"date": row.get("date"),
                        "ms": row.get("ms", row.get("milliseconds")),
                        "value": row.get("value"),
                        "controller": row.get("controller")})
        elif len(row) >= 4:
            out.append({"date": row[0], "ms": row[1], "value": row[2],
                        "controller": row[3]})
        elif len(row) == 3:
            out.append({"date": row[0], "ms": row[1], "value": row[2],
                        "controller": None})
        else:
            out.append({"date": None, "ms": row[0], "value": row[1], "controller": None})
    return out


def _read_cc(src, part_index):
    """``[(selector | None, rows), ...]`` for one part.

    A ``<controller>_cc`` key selects that controller's *position* stream; a flat key is
    compared against the whole control-change list. The v4 generator writes only
    **part 0's** stream (``generate_v4.mjs::sustainStream`` reads ``data.parts[0]``), so a
    record-level CC key is ground truth for the first part alone -- which is exactly why
    :func:`pilot_mode` prints the *fraction* of rendered control-change points that a run
    actually compared instead of only the absolute count.
    """
    out = []
    for key, controller in _CC_KEYS_BY_CONTROLLER.items():
        if src.get(key) is not None and part_index == 0:
            out.append((("position", controller), _cc_rows(src[key]), key))
    for key in _CC_KEYS_FLAT:
        if src.get(key) is not None and part_index == 0:
            out.append((None, _cc_rows(src[key]), key))
    return out


def _read_notes(rows):
    """``([(date, duration), ...], [{ms_on, ms_off, velocity}, ...])``."""
    notes, ref = [], []
    for r in rows:
        notes.append((r[0], r[1]))
        ref.append({"ms_on": r[3] if len(r) > 3 else None,
                    "ms_off": r[4] if len(r) > 4 else None,
                    "velocity": r[5] if len(r) > 5 else None})
    return notes, ref


def _present_maps(src):
    """The maps a record actually asked the renderer for.

    An **empty list is not an empty map** in this schema: ``ml/node/xml.mjs::buildMpm``
    writes a map element only ``if (maps.X && maps.X.length)``, so a JSONL ``"dynamics": []``
    means *the MPM had no dynamicsMap at all*. The distinction is observable since
    ``perf_chain_v4`` D0 -- a present-but-empty ``<dynamicsMap/>`` suppresses the velocity
    attribute entirely, while an absent one defaults it to 100.0 -- so the two must not be
    conflated on the way in. (``pilot_v4_exact.jsonl`` carries exactly this: ``dynamics: []``
    with ``velocity: 100`` in the notes, which is the absent-map reading.)

    LIMITATION, worth a schema field: the JSONL therefore *cannot express* a deliberately
    empty map element. No generator in this program emits one; a generator that starts to
    would need an explicit marker (e.g. ``"dynamics": {"empty": true}``).
    """
    return {k: src[k] for k in MAP_FIELDS if src.get(k)}


def _split_articulation(global_maps):
    """Pop a part-keyed articulation map out of ``global_maps`` and index it by part number.

    Schema v4.1 (``ml/node/generate_v4.mjs``, 2026-08-09) writes articulation rows as
    ``[date, relativeDuration, velocityChange, part]`` because articulationMaps became
    part-local (CANONICAL A6). Earlier records -- every v3 file and the pre-A6 v4 pilots --
    write the 3-tuple of one *global* map, which must keep rendering exactly as it did:
    those files' bit-exactness proofs are the regression test for this function.

    Returns ``{part_number: [[date, relDur, velChange], ...]}`` for the part-local shape, or
    ``None`` when the record carries the old global shape (in which case ``global_maps``
    is left untouched). Mixed arities are a corrupt record, not a shape to guess at.
    """
    rows = global_maps.get("articulation")
    if not rows:
        return None
    widths = {len(r) for r in rows}
    if widths == {3}:
        return None
    if widths != {4}:
        raise ValueError(f"articulation rows mix widths {sorted(widths)}; expected all 3 "
                         f"(global, pre-A6) or all 4 (part-local)")
    global_maps.pop("articulation")
    out = {}
    for date, rel_dur, vel_change, part in rows:
        out.setdefault(part, []).append([date, rel_dur, vel_change])
    return out


def _record_parts(rec):
    """Normalise a pilot record to ``(global_maps, [part_spec, ...], [ref, ...], keys, raw)``.

    Three shapes are understood:

    **v4 flat** (``ml/node/generate_v4.mjs``) -- one record, maps at the top level, notes as
    ``[date, dur, pitch, msOn, msOff, vel, part]``. The 7th element splits the notes into
    parts. The maps are global *except* ``asynchrony``, which the generator attaches to the
    **last** part only (sampler rule AS0: "part 1 carries no asynchronyMap"), and which the
    record flattens across parts. Note that this assumption is not decoration: if it were
    wrong, part 1's onsets would come out shifted and the bit-comparison would fail loudly.

    **explicit parts** -- ``{"parts": [{"notes", <maps>}, ...]}``, maps resolved per part
    with the record-level ones as globals.

    **v3 single-part** -- the v3 schema, no v4 maps; validated for backward compatibility.

    ``raw`` is the per-part list of the record's own note rows (pitch included), which
    :func:`attribute_mode` needs to rebuild the MSM the renderer was given.
    """
    keys = set()

    if "parts" in rec:
        global_maps = _present_maps(rec)
        artic_by_part = _split_articulation(global_maps)
        specs, refs, raw = [], [], []
        for i, p in enumerate(rec["parts"]):
            rows = p.get("notes") or []
            notes, ref_notes = _read_notes(rows)
            spec = {"number": p.get("number", i + 1), "name": p.get("name"),
                    "notes": notes}
            if artic_by_part is not None and artic_by_part.get(spec["number"]):
                spec["articulation"] = artic_by_part[spec["number"]]
            # A key present with an empty list means "no such map element" (see
            # _present_maps); a key present with rows is a local map that shadows the global.
            for k, v in _present_maps(p).items():
                spec[k] = v
            specs.append(spec)
            raw.append(rows)
            cc = _read_cc(p, i) or _read_cc(rec, i)
            keys.update(c[2] for c in cc)
            refs.append({"notes": ref_notes, "cc": [(s, r) for s, r, _k in cc]})
        return global_maps, specs, refs, keys, raw

    rows = rec.get("notes") or []
    by_part = {}
    for r in rows:
        by_part.setdefault(r[6] if len(r) > 6 else 1, []).append(r)
    numbers = sorted(by_part)
    global_maps = _present_maps(rec)
    asyn = global_maps.pop("asynchrony", None)
    artic_by_part = _split_articulation(global_maps)

    specs, refs, raw = [], [], []
    for i, number in enumerate(numbers):
        notes, ref_notes = _read_notes(by_part[number])
        spec = {"number": number, "notes": notes}
        # AS0: the asynchronyMap is part-local and sits on the LAST part. Every other part
        # simply has no asynchronyMap; since there is no *global* one either, that is spelled
        # by omission -- the same thing meico's `if (localMap == null) localMap = globalMap;`
        # would do with a null local map.
        if asyn and number == numbers[-1]:
            spec["asynchrony"] = asyn
        # A6 (schema v4.1): articulationMaps are part-local. Same omission convention -- a
        # part with no articulation row has no `<articulationMap>` element at all.
        if artic_by_part is not None and artic_by_part.get(number):
            spec["articulation"] = artic_by_part[number]
        specs.append(spec)
        raw.append(by_part[number])
        cc = _read_cc(rec, i)
        keys.update(c[2] for c in cc)
        refs.append({"notes": ref_notes, "cc": [(s, r) for s, r, _k in cc]})
    return global_maps, specs, refs, keys, raw


def _cross_java(path, limit, verbose=False, keep=False):
    """Re-render the first ``limit`` pilot records through the Java fork and compare
    **everything**, for every part.

    This exists because the pilot's own ground truth is partial: ``generate_v4.mjs`` writes
    only ``data.parts[0]``'s sustain stream, so roughly half of the rendered control-change
    output -- and specifically the part that carries the asynchronyMap under sampler rule
    AS0, i.e. the whole *asynchrony-on-positionMap* path -- has nothing in the file to check
    it against. Rendering the same MSM+MPM through the fork supplies the missing half at
    pilot scale instead of leaving it to the hand-built battery.

    No dataset is produced: the documents live in a temp dir and are deleted.
    """
    cases = []
    with open(path) as fh:
        for line_no, line in enumerate(fh):
            line = line.strip()
            if not line or len(cases) >= limit:
                continue
            rec = json.loads(line)
            name = "xj_%s" % rec.get("id", line_no)
            msm, mpm, gmaps, specs, _refs = _pilot_xml(rec, name)
            cases.append((name, "", msm, mpm,
                          (gmaps, specs, rec.get("movementSampleMaxStep"))))
    if not cases:
        print("  cross-java: no records")
        return True

    workdir = tempfile.mkdtemp(prefix="validate_v4_xj_",
                               dir=os.environ.get("TMPDIR") or None)
    try:
        rendered = _run_java(cases, workdir, verbose=verbose)
        ok, notes_d, cc_d, errors, counts, stats, _pc = _compare_cases(cases, rendered)
        print("\n  cross-java (fork re-render of the first %d records, ALL parts, ALL "
              "control changes): %d parts, %d notes, %d position events, %d channelVolume "
              "events" % (len(cases), counts["parts"], counts["notes"], counts["positions"],
                          counts["volumes"]))
        print("    asynchrony-on-positionMap events now covered: %d"
              % stats.get("asyn_pos_start_shifted", 0))
        notes_d.report("    ")
        cc_d.report("    ")
        if errors:
            print("    SHAPE ERRORS (%d):" % len(errors))
            for m in errors[:20]:
                print("      " + m)
        print("    %s" % ("EXACT" if ok else "MISMATCH"))
        return ok
    finally:
        if keep:
            print("  kept: %s" % workdir)
        else:
            shutil.rmtree(workdir, ignore_errors=True)


def _config_fingerprint(rec):
    """What a record actually configures, so two files that share a name can be told apart.

    Team D's three pilots are NOT one sample under three renderers: ``pilot_v4.jsonl`` and
    ``pilot_v4_espressivo.jsonl`` are the same sample rendered twice, while
    ``pilot_v4_exact.jsonl`` is a *different* configuration (no dynamicsMap, no
    articulationMap) despite the name. The renderer itself is not recorded anywhere in the
    JSONL, so it can only be inferred -- see the note printed at the end of a run.
    """
    return tuple(sorted(k for k in MAP_FIELDS if rec.get(k)))


def pilot_mode(path, verbose=False, cross_java=0, keep=False):
    notes_d = Diffs(["ms_on", "ms_off", "velocity"])
    cc_d = Diffs(["cc_ms", "cc_value"])
    n_rec = n_parts = n_notes = n_cc = n_pos_rendered = n_vol_rendered = 0
    n_mov_rows = n_asyn_rows = n_mov_pieces = n_asyn_pieces = 0
    shape_errors = []
    cc_keys = set()
    agg_stats = {}
    part_counts = {}
    configs = {}
    meta_keys = set()
    cc_parts = set()
    cc_stats_parts = set()
    cc_encodings = set()

    with open(path) as fh:
        for line_no, line in enumerate(fh):
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            gmaps, specs, refs, keys, _raw = _record_parts(rec)
            cc_keys.update(keys)
            part_counts[len(specs)] = part_counts.get(len(specs), 0) + 1
            cfg = _config_fingerprint(rec)
            configs[cfg] = configs.get(cfg, 0) + 1
            meta_keys.update(k for k in rec
                             if k not in MAP_FIELDS and k not in ("notes",)
                             and k not in _CC_KEYS_BY_CONTROLLER and k not in _CC_KEYS_FLAT)
            rid = rec.get("id", line_no)

            movs = sum(len(s.get("movement") or []) for s in specs) + \
                len(gmaps.get("movement") or [])
            asyns = sum(len(s.get("asynchrony") or []) for s in specs) + \
                len(gmaps.get("asynchrony") or [])
            n_mov_rows += movs
            n_asyn_rows += asyns
            n_mov_pieces += 1 if movs else 0
            n_asyn_pieces += 1 if asyns else 0

            chain = PerfChainV4(specs, global_maps=gmaps,
                                movement_sample_max_step=rec.get("movementSampleMaxStep"))
            got_parts = chain.render()
            for k, v in chain.stats.items():
                agg_stats[k] = agg_stats.get(k, 0) + v
            n_rec += 1

            for pp, ref in zip(got_parts, refs):
                n_parts += 1
                if len(pp.notes) != len(ref["notes"]):
                    shape_errors.append("rec %s part %s: %d notes vs %d reference"
                                        % (rid, pp.number, len(pp.notes),
                                           len(ref["notes"])))
                for i, (g, e) in enumerate(zip(pp.notes, ref["notes"])):
                    where = "rec %s/p%s/n%d" % (rid, pp.number, i)
                    notes_d.add("ms_on", g.ms_on, e["ms_on"], where)
                    notes_d.add("ms_off", g.ms_off, e["ms_off"], where)
                    if e["velocity"] is not None:
                        notes_d.add("velocity", g.velocity, e["velocity"], where)
                    n_notes += 1

                shape_errors.extend(_check_stream_partition(pp, "rec %s/p%s"
                                                            % (rid, pp.number)))
                n_pos_rendered += len(pp.positions)
                n_vol_rendered += len(pp.volumes)
                if pp.positions:
                    cc_stats_parts.add(pp.index)
                for selector, rows in ref["cc"]:
                    if selector is None:
                        # a flat list: the whole control-change output, positions only if
                        # the lengths say the channelVolume reset is not included
                        got = (pp.positions if len(rows) == len(pp.positions)
                               else pp.volumes + pp.positions)
                    else:
                        stream = pp.stream(*selector)
                        got = stream.points if stream is not None else []
                    cc_parts.add(pp.index)
                    # Ground truth carrying only integers is the MIDI observable
                    # (generate_v4.mjs:406, and the Vienna corpus); anything else is the raw
                    # positionMap double. Rounding is idempotent on integral rendered values,
                    # so this branch never weakens a file that stores the raw doubles.
                    rounded = bool(rows) and all(
                        r["value"] is not None and float(r["value"]).is_integer()
                        for r in rows)
                    cc_encodings.add("MIDI round(value)" if rounded else "raw double")
                    n_cc += _compare_cc(got, rows, "rec %s/p%s/cc" % (rid, pp.number),
                                        cc_d, shape_errors, round_value=rounded)

    print("pilot %s: %d records, %d parts, %d notes, %d cc points"
          % (path, n_rec, n_parts, n_notes, n_cc))
    print("  parts per record: %s" % ", ".join("%d->%d" % (k, v)
                                               for k, v in sorted(part_counts.items())))
    print("  movement rows: %d in %d records   asynchrony rows: %d in %d records"
          % (n_mov_rows, n_mov_pieces, n_asyn_rows, n_asyn_pieces))
    print("  map configuration(s): %s"
          % "; ".join("%s x%d" % ("+".join(cfg) or "(none)", n)
                      for cfg, n in sorted(configs.items(), key=lambda kv: -kv[1])))
    print("  record metadata keys: %s" % (", ".join(sorted(meta_keys)) or "(none)"))
    print("  cc ground-truth key(s): %s   value encoding: %s"
          % (", ".join(sorted(cc_keys)) or "NONE FOUND",
             ", ".join(sorted(cc_encodings)) or "n/a"))
    # COVERAGE, not just volume: the generator writes only part 0's stream, so half of the
    # rendered positionMap output has no ground truth at all. Print the fraction so a partial
    # check is never read as a full one. The channelVolume resets are counted separately --
    # no generator in this program records them, and they are one event per record.
    print("  cc coverage: %d of %d rendered positionMap points compared (%.0f%%), plus %d "
          "channelVolume reset events rendered and never recorded; positions have ground "
          "truth for part index %s and are rendered for %s"
          % (n_cc, n_pos_rendered, (100.0 * n_cc / n_pos_rendered) if n_pos_rendered else 0.0,
             n_vol_rendered, sorted(cc_parts) or "(none)",
             sorted(cc_stats_parts) or "(none)"))
    print("  meico order-dependent paths exercised: "
          + "  ".join("%s=%d" % (k, agg_stats[k]) for k in sorted(agg_stats)
                      if agg_stats[k]))
    notes_d.report()
    cc_d.report()
    if shape_errors:
        print("  SHAPE ERRORS (%d):" % len(shape_errors))
        for m in shape_errors[:20]:
            print("    " + m)
    if verbose:
        notes_d.report_worst()
        cc_d.report_worst()

    if n_mov_rows == 0 and n_asyn_rows == 0:
        print("  WARNING: this dataset exercises neither movement nor asynchrony")
    # A movementMap that renders a positionMap with no ground truth to compare would pass
    # vacuously on the whole CC half; refuse that verdict explicitly. Only *position* events
    # count -- the channelVolume reset is emitted by every dynamicsMap, has been recorded by
    # no generator in this program, and is fully covered by the java-mode battery.
    cc_vacuous = n_pos_rendered > 0 and n_cc == 0
    if cc_vacuous:
        print("  VACUOUS: %d positionMap points were rendered and NONE were compared "
              "(no recognised cc ground-truth key). Add one of %s to the record."
              % (n_pos_rendered,
                 ", ".join(sorted(_CC_KEYS_BY_CONTROLLER) + list(_CC_KEYS_FLAT))))
    unchecked = sorted(cc_stats_parts - cc_parts)
    if unchecked:
        print("  NOTE: parts %s render a positionMap with no ground truth in the file. "
              "Under sampler rule AS0 the asynchronyMap sits on the LAST part, so the "
              "asynchrony-on-positionMap path (asyn_pos_* above) is counted there but has "
              "no pilot-scale ground truth; run --cross-java to cover it against the fork."
              % unchecked)
    ok = (notes_d.ok() and cc_d.ok() and not shape_errors and n_notes > 0
          and not cc_vacuous)
    if cross_java:
        ok = _cross_java(path, cross_java, verbose=verbose, keep=keep) and ok
    print("EXACT" if ok else "MISMATCH")
    if not ok and not shape_errors and not cc_vacuous:
        worst_ulp = max(list(notes_d.max_ulp.values()) + list(cc_d.max_ulp.values()))
        if worst_ulp <= 4.0:
            print("  ...every divergence is a handful of ulps. That is the signature of a"
                  " dataset rendered by espressivo rather than the Java fork: JS' Math.pow"
                  " is not fdlibm, so a value that passed through the tempo power function"
                  " or the rubato warp can land an ulp away, and a later sum can carry it.")
        else:
            print("  ...divergences are far larger than a rounding ulp: look for a semantic"
                  " difference (espressivo's articulation and dynamics-curvature defects"
                  " reported by --espressivo are the known ones) rather than a libm one.")
        print("  Attribution is decidable, not assumed:  python3 validate_v4.py --attribute"
              " %s  re-renders exactly the differing records through ml/java/RenderMpm and"
              " prints the three bit patterns side by side." % path)
    return 0 if ok else 1


# =======================================================================================
#  ATTRIBUTION MODE -- who is wrong when a pilot file and this port disagree?
# =======================================================================================
#
# A divergence between a JSONL and this port has three possible authors: the port, the
# renderer that wrote the JSONL, or the Java fork the port claims to reproduce. Prose cannot
# separate them; a third opinion can. This mode re-renders exactly the differing records
# through ml/java/RenderMpm and prints the three bit patterns side by side, so the reader can
# check the conclusion instead of taking it.


def _pilot_xml(rec, name):
    """Rebuild the MSM + MPM a pilot record was rendered from.

    Faithful up to two token-level aliases that provably do not change the rendering:
    ``ml/node/xml.mjs`` always writes ``controller="sustain"`` where the JSONL row has no
    controller field (absent -> the same default, ``movement_math`` Q6), and it omits
    ``curvature``/``protraction`` when they equal MovementData's field initialisers while
    this writer emits the number the JSONL carries (same value either way).
    """
    gmaps, specs, refs, _keys, raw = _record_parts(rec)
    parts_msm, parts_mpm = [], []
    for i, (spec, rows) in enumerate(zip(specs, raw)):
        number = spec.get("number", i + 1)
        pname = spec.get("name") or ("P%d" % number)
        notes = [(r[0], r[1], r[2] if len(r) > 2 else 60.0) for r in rows]
        parts_msm.append((pname, number, i, 0, notes))
        parts_mpm.append((pname, number, i, 0,
                          {k: spec[k] for k in MAP_FIELDS if k in spec}))
    return _msm(name, parts_msm), _mpm(gmaps, parts_mpm), gmaps, specs, refs


def _attr_rows(got_parts, refs, java_parts=None, midi_round=True):
    """``[(part, kind, idx, field, python, jsonl, java)]`` for one record.

    ``None`` in a slot means "this source has no such value"; the caller only prints rows
    where the three sources disagree, so the extraction stays exhaustive on purpose.

    ``midi_round`` puts ``cc_value`` into the same domain as the ground truth when that is
    the MIDI observable (see :func:`_js_round`) -- otherwise every fractional sample would be
    reported as a divergence from a file that never stored the fraction. Pass ``False`` for
    the raw python-vs-fork cross-check, which must stay full precision.
    """
    rows = []
    for pp, ref in zip(got_parts, refs):
        jp = (java_parts or {}).get(pp.number)
        jnotes = (jp or {}).get("notes") or []
        for i, (g, e) in enumerate(zip(pp.notes, ref["notes"])):
            jn = jnotes[i] if i < len(jnotes) else {}
            for field, gv, ev in (("ms_on", g.ms_on, e["ms_on"]),
                                  ("ms_off", g.ms_off, e["ms_off"]),
                                  ("velocity", g.velocity, e["velocity"])):
                rows.append((pp.number, "note", i, field, gv, ev, jn.get(field)))
        for selector, cc_ref in ref["cc"]:
            if selector is None:
                got = (pp.positions if len(cc_ref) == len(pp.positions)
                       else pp.volumes + pp.positions)
                jcc = ((jp or {}).get("volumes") or []) + ((jp or {}).get("positions") or [])
                if len(cc_ref) == len(pp.positions):
                    jcc = (jp or {}).get("positions") or []
            else:
                stream = pp.stream(*selector)
                got = stream.points if stream is not None else []
                jcc = [p for p in ((jp or {}).get("positions") or [])
                       if p.get("controller") == selector[1]]
            rnd = midi_round and bool(cc_ref) and all(
                r["value"] is not None and float(r["value"]).is_integer() for r in cc_ref)
            conv = _js_round if rnd else (lambda x: x)
            field = "cc_val*" if rnd else "cc_value"
            for i, (g, e) in enumerate(zip(got, cc_ref)):
                j = jcc[i] if i < len(jcc) else {}
                jv = j.get("value")
                rows.append((pp.number, "cc", i, "cc_ms", g.ms, e["ms"], j.get("ms")))
                rows.append((pp.number, "cc", i, field, conv(g.value), e["value"],
                             None if jv is None else conv(jv)))
    return rows


#: rows printed per verdict class before the table is truncated (counts stay complete)
_ATTR_PRINT_CAP = 30


def _hexbits(v):
    return "-" if v is None else "0x%016x" % _bits(v)


def attribute_mode(path, verbose=False, keep=False):
    """Re-render every record that differs from this port through the Java fork."""
    records, differing = [], []
    with open(path) as fh:
        for line_no, line in enumerate(fh):
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            records.append((line_no, rec))

    for line_no, rec in records:
        _g, specs, refs, _k, _raw = _record_parts(rec)
        got = PerfChainV4(specs, global_maps=_g,
                          movement_sample_max_step=rec.get("movementSampleMaxStep")).render()
        bad = [r for r in _attr_rows(got, refs)
               if not (r[4] is None and r[5] is None)
               and (r[4] is None or r[5] is None or not _bit_identical(r[4], r[5]))]
        if bad:
            differing.append((line_no, rec, bad))

    print("attribution for %s: %d records, %d differ from this port"
          % (path, len(records), len(differing)))
    if not differing:
        print("nothing to attribute -- the port reproduces this file bit for bit")
        return 0
    print("  differing records: %s"
          % ", ".join(str(rec.get("id", ln)) for ln, rec, _b in differing))

    workdir = tempfile.mkdtemp(prefix="validate_v4_attr_",
                               dir=os.environ.get("TMPDIR") or None)
    try:
        cases = []
        for line_no, rec, _bad in differing:
            name = "attr_%s" % rec.get("id", line_no)
            msm, mpm, _g, _s, _r = _pilot_xml(rec, name)
            cases.append((name, "", msm, mpm, ({}, [], None)))
        rendered = _run_java(cases, workdir, verbose=verbose)

        print("\n%-6s %-4s %-5s %-8s %-18s %-18s %-18s %s"
              % ("rec", "part", "idx", "field", "python(bits)", "jsonl(bits)",
                 "javafork(bits)", "verdict"))
        n_all = n_py_java_neq = 0
        verdicts = {}
        for (line_no, rec, _bad), (name, _n, _m, _p, _s) in zip(differing, cases):
            _g, specs, refs, _k, _raw = _record_parts(rec)
            got = PerfChainV4(
                specs, global_maps=_g,
                movement_sample_max_step=rec.get("movementSampleMaxStep")).render()
            java_parts = _parse_augmented(rendered[name])
            rows = _attr_rows(got, refs, java_parts)
            rid = rec.get("id", line_no)
            # the raw, full-precision python-vs-fork cross-check on the same record
            for _p, _k, _i, _f, py, _js, jv in _attr_rows(got, refs, java_parts,
                                                          midi_round=False):
                if py is not None and jv is not None:
                    n_all += 1
                    if not _bit_identical(py, jv):
                        n_py_java_neq += 1
            for part, kind, idx, field, py, js, jv in rows:
                same_js = (py is None and js is None) or (
                    py is not None and js is not None and _bit_identical(py, js))
                if same_js:
                    continue
                if py is None or jv is None:
                    verdict = "SHAPE (a value is absent on one side)"
                elif _bit_identical(py, jv):
                    verdict = "PY==JAVA"          # the JSONL is the odd one out
                elif js is not None and _bit_identical(js, jv):
                    verdict = "JSONL==JAVA  <-- THE PORT IS WRONG"
                else:
                    verdict = "ALL THREE DIFFER"
                verdicts[verdict] = verdicts.get(verdict, 0) + 1
                # print at most PRINT_CAP rows per verdict class: the counts below are
                # complete, the table is evidence, and a semantic divergence produces
                # thousands of identical-looking lines.
                if verdicts[verdict] <= _ATTR_PRINT_CAP or verbose:
                    print("%-6s %-4s %-5s %-8s %-18s %-18s %-18s %s"
                          % (rid, part, idx, field, _hexbits(py), _hexbits(js),
                             _hexbits(jv), verdict))
                elif verdicts[verdict] == _ATTR_PRINT_CAP + 1:
                    print("  ... more %s rows suppressed (--verbose prints them all)"
                          % verdict)
        print("\n  %d differing values: %s"
              % (sum(verdicts.values()),
                 ", ".join("%s=%d" % kv for kv in sorted(verdicts.items()))))
        print("  (`cc_val*` = the MIDI observable Math.round(value), the domain this file's"
              " ground truth is stored in; every other field is the raw double)")
        print("  full-record cross-check on the same records, RAW full precision: %d of %d"
              " python-vs-fork values are non-bit-identical" % (n_py_java_neq, n_all))
        ok = (n_py_java_neq == 0
              and not any(v.startswith("JSONL==JAVA") or v.startswith("ALL")
                          for v in verdicts))
        print("ATTRIBUTED TO THE RENDERER THAT WROTE THE JSONL" if ok
              else "PORT DEFECT OR UNRESOLVED -- see the table")
        return 0 if ok else 1
    finally:
        if keep:
            print("kept: %s" % workdir)
        else:
            shutil.rmtree(workdir, ignore_errors=True)


# =======================================================================================

def main(argv):
    verbose = "--verbose" in argv
    keep = "--keep" in argv
    list_only = "--list" in argv
    negative = "--negative" in argv
    espressivo = "--espressivo" in argv
    attribute = "--attribute" in argv
    force_java = "--java" in argv or list_only or negative
    positional = [a for a in argv if not a.startswith("--")]
    cross_java = 0
    if "--cross-java" in argv:
        i = argv.index("--cross-java")
        cross_java = 12
        if i + 1 < len(argv) and argv[i + 1].isdigit():
            cross_java = int(argv[i + 1])
            positional = [a for a in positional if a != argv[i + 1]]

    if attribute:
        if not positional:
            raise SystemExit("--attribute needs a pilot JSONL path")
        return attribute_mode(positional[0], verbose=verbose, keep=keep)

    if espressivo and not force_java:
        return espressivo_mode(verbose=verbose, keep=keep)

    if positional and not force_java:
        return pilot_mode(positional[0], verbose, cross_java=cross_java, keep=keep)
    if not force_java:
        found = sorted(glob.glob(os.path.join(ML, "data", "pilot_v4*.jsonl")))
        if found:
            print("found Team D pilot(s): %s\n" % ", ".join(os.path.basename(f)
                                                            for f in found))
            results = []
            for f in found:
                rc = pilot_mode(f, verbose, cross_java=cross_java, keep=keep)
                results.append((os.path.basename(f), rc))
                print()
            print("=" * 78)
            for base, rc in results:
                print("  %-34s %s" % (base, "EXACT" if rc == 0 else "MISMATCH"))
            print("A pilot rendered by espressivo rather than the Java fork is EXPECTED to\n"
                  "mismatch here: this port reproduces the FORK, and espressivo differs from\n"
                  "it by the libm ulp and by the two parsing defects reported above.")
            return 0 if all(rc == 0 for _b, rc in results) else 1
        print("no ml/data/pilot_v4*.jsonl yet -- validating against the Java fork directly")
    return java_mode(verbose=verbose, keep=keep, list_only=list_only,
                     negative=negative, espressivo_too=espressivo)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
