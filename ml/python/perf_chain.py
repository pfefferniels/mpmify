"""Exact Python port of meico's per-part performance-rendering chain for MSM score notes.

Order of operations (meico ``Performance.perform()``, lines 507-549), mirrored here:

  1. ``DynamicsMap.renderDynamicsToMap(score, dynamicsMap)`` -- writes ``velocity``
     (evaluated at the note's *unwarped* map key), 100.0 before the first instruction
     and 100.0 for every note if there is no dynamicsMap at all.
  2. ``ArticulationMap.renderArticulationToMap_noMillisecondModifiers(score, articulationMap)``
     -- tick-domain modifiers: ``relativeDuration`` multiplies ``duration.perf``,
     ``absoluteVelocityChange`` is *added* to the velocity produced in step 1.
  3. ``RubatoMap.renderRubatoToMap(score, rubatoMap)`` -- warps ``date.perf`` and creates
     ``date.end.perf`` ( = *map key* + ``duration.perf``) and warps that, too.
  4. ``TempoMap.renderTempoToMap(score, ppq, tempoMap)`` -- ticks -> milliseconds.

Subtleties that only become observable once rubato is in play, and that a naive
"warp, then look up the tempo curve" implementation gets wrong:

  * meico selects the tempo/rubato instruction by the note's **unwarped map key**, but
    evaluates the tempo curve at the **warped ``date.perf``**. A warped date may therefore
    lie outside its own tempo segment, and ``TempoMap.getTempoAt()`` does *not* clamp:
    it evaluates ``pow((date-start)/(end-start), exponent)`` even for ratios > 1 (and
    would return NaN for ratios < 0 -- the v3 sampler prevents that case by keeping
    tempo instructions off the interior of rubato frames).
  * The very first tempo instruction: elements whose key is ``<= td.startDate`` are timed
    with ``computeMillisecondsForNoTempo(date) = 600*date/ppq`` -- i.e. notes at date 0 of a
    piece are timed at a fixed 100 bpm if rubato moved their ``date.perf`` off zero.
  * ``date.end.perf`` is created by the rubato stage from the note's **map key** plus
    ``duration.perf``, but by the tempo stage from ``date.perf`` plus ``duration.perf``.
    A note whose onset was warped therefore gets a *different* (rubato-derived) offset
    than an unwarped one.
  * meico's ``pendingDurations`` loop in ``renderRubatoToMap()`` (``RubatoMap.java:392``)
    **breaks** on the first out-of-scope entry, while the equivalent loop of the tempo
    stage (``TempoMap.java:426``) **continues**. Both are reproduced literally below.

    The two semantics only differ when a *later* pending entry is still in scope behind an
    out-of-scope one, i.e. when note end dates are **not monotone** in map order — which
    requires overlapping notes. The canonical v3 score sampler is strictly sequential
    (``t += dur``, chords share a date), so its end dates *are* monotone and the two
    semantics coincide on every canonical pilot. ``render()`` therefore counts the
    discriminating events in ``self.stats`` (``rubato_pending_break``,
    ``rubato_pending_blocked``, ``tempo_pending_skipped``, ``tempo_pending_revisited``):
    ``*_blocked``/``*_revisited`` > 0 is the only evidence that the port's break/continue
    choice is under test. It is exercised by the deliberately non-canonical
    ``polyphony`` pilot (see ``java/SampleAndRender.java``), where flipping ``break`` to
    ``continue`` turns the validation from EXACT into a mismatch. (An earlier version of
    this note claimed a 245-note effect in the canonical pilot; that number was the count
    of notes whose *own* offset fell out of the rubato scope, which ``continue`` would
    have handled identically. ``rubato_pending_blocked`` is 0 on every canonical pilot.)

The class works on a whole score (list of ``(date, duration)`` in map order) because of
that last point; ``note_perf()`` is a convenience wrapper for a single note.

Floating point: all transcendental calls go through ``rubato_math.java_pow`` /
``java_log`` (bit-exact fdlibm ports), not the platform libm -- see the comment block in
``rubato_math``. That is what makes the reproduction bit-exact rather than 1-ulp-close.
"""

from dynamics_math import DynamicsTimeline
from rubato_math import (JAVA_DOUBLE_MAX, RUB_DATE, RUB_EARLY_END, RUB_FRAME,  # noqa: F401
                         RUB_INTENSITY, RUB_LATE_START, RUB_LOOP, RubatoTimeline,
                         java_log, java_pow, warp)
from tempo_math import BEAT_LENGTH, PPQ, TempoTimeline

__all__ = ["PerfChain", "NotePerf"]


class NotePerf:
    """Rendered performance data of a single score note."""

    __slots__ = ("date", "duration", "date_perf", "date_end_perf", "duration_perf",
                 "ms_on", "ms_off", "velocity")

    def __init__(self, date, duration):
        self.date = date
        self.duration = duration
        self.date_perf = float(date)
        self.date_end_perf = None
        self.duration_perf = float(duration)
        self.ms_on = None
        self.ms_off = None
        self.velocity = 100.0

    def __repr__(self):
        return ("NotePerf(date=%s, dur=%s, date_perf=%s, date_end_perf=%s, ms_on=%s, "
                "ms_off=%s, vel=%s)" % (self.date, self.duration, self.date_perf,
                                        self.date_end_perf, self.ms_on, self.ms_off,
                                        self.velocity))


# ---------------------------------------------------------------- tempo primitives
# These mirror meico's TempoMap exactly, including its behaviour *outside* the segment
# (tempo_math.tempo_at clamps at the segment end, meico's getTempoAt only special-cases
# date == endDate; identical inside a segment, different for warped dates beyond it),
# and its Java-exact pow/log.


def _require_sorted(rows, what):
    for i in range(1, len(rows)):
        if rows[i][0] < rows[i - 1][0]:
            raise ValueError("%s map is not sorted by date: row %d (date %s) precedes row "
                             "%d (date %s)" % (what, i, rows[i][0], i - 1, rows[i - 1][0]))


class _TempoSeg:
    """meico TempoData for one tempo instruction (exponent cached, as meico does)."""

    __slots__ = ("start", "bpm", "to", "mta", "end", "constant", "exponent", "start_ms")

    def __init__(self, instr, end):
        self.start = instr[0]
        self.bpm = instr[1]
        self.to = instr[2]
        self.mta = instr[3]
        self.end = end
        self.constant = (self.to is None) or (self.to == self.bpm)
        # meico: exponent = 1.0 if meanTempoAt is absent, else log(0.5)/log(meanTempoAt)
        self.exponent = 1.0 if self.mta is None else java_log(0.5) / java_log(self.mta)
        self.start_ms = 0.0


def _tempo_at(date, seg):
    """meico TempoMap.getTempoAt(date, tempoData) -- note: no clamping outside [start,end]"""
    if seg.constant:
        return seg.bpm
    if date == seg.end:
        return seg.to
    result = (date - seg.start) / (seg.end - seg.start)
    result = java_pow(result, seg.exponent)
    return result * (seg.to - seg.bpm) + seg.bpm


def _ms_no_tempo(date):
    """meico TempoMap.computeMillisecondsForNoTempo(date, ppq)"""
    return (600.0 * date) / PPQ


def _diff_timing(date, seg):
    """meico TempoMap.computeDiffTiming(date, ppq, tempoData) for a non-null tempoData."""
    if seg.constant:                                    # computeMillisecondsForConstantTempo
        return (15000.0 * (date - seg.start)) / (seg.bpm * BEAT_LENGTH * PPQ)

    # computeMillisecondsForTempoTransition: Simpson's rule, 16th-note precision
    n2 = 2.0 * int((date - seg.start) / (PPQ / 4.0))    # Java: 2.0 * (long)(...) truncation
    if n2 == 0.0:
        n2 = 2.0
    n = n2 / 2.0
    x = (date - seg.start) / n2
    result_const = ((date - seg.start) * 5000.0) / (n2 * BEAT_LENGTH * PPQ)
    result_sum = 1.0 / seg.bpm + 1.0 / _tempo_at(date, seg)
    k = 1
    while k < n:
        result_sum += 2.0 / _tempo_at(seg.start + 2 * k * x, seg)
        k += 1
    k = 1
    while k <= n:
        result_sum += 4.0 / _tempo_at(seg.start + (2 * k - 1) * x, seg)
        k += 1
    return result_const * result_sum


class PerfChain:
    """Composes the four maps of the v3 canonical form into meico's rendering chain.

    ``tempo``        : [[date, bpm, transition_to|None, mean_tempo_at|None], ...] or None
    ``dynamics``     : [[date, volume, transition_to|None, curvature|None, protraction|None], ...]
    ``articulation`` : [[date, relative_duration, absolute_velocity_change], ...]
    ``rubato``       : [[date, frame_length, intensity, late_start, early_end, loop01], ...]

    ``tempo=None`` selects meico's no-tempoMap fallback (1 tick = 1 ms), ``tempo=[]`` its
    empty-tempoMap branch (a fixed 100 bpm at beatLength 0.25).
    """

    def __init__(self, tempo=None, dynamics=None, articulation=None, rubato=None):
        self.tempo = list(tempo) if tempo else ([] if tempo is not None else None)
        self.dynamics = list(dynamics or [])
        self.articulation = list(articulation or [])
        self.rubato = list(rubato or [])

        # meico sorts every map on parse (GenericMap ctor / insertElement, stable for equal
        # dates) and renders in that order, so a caller-supplied out-of-order map would be
        # rendered by meico and by this port in *different* orders. Refuse it rather than
        # silently diverge. (rubato is checked in RubatoTimeline.)
        _require_sorted(self.tempo or [], "tempo")
        _require_sorted(self.dynamics, "dynamics")
        _require_sorted(self.articulation, "articulation")

        self.dyn_timeline = DynamicsTimeline(self.dynamics) if self.dynamics else None
        self.rub_timeline = RubatoTimeline(self.rubato) if self.rubato else None

        # meico collects *all* articulations of a note into one list and applies them in map
        # order (ArticulationMap.java:400-461: noteArtics is a note -> ArrayList map, and the
        # render loop iterates that list). Keeping only the last one per date -- as a plain
        # ``{a[0]: a for a in ...}`` dict does -- silently drops stacked articulations.
        # The canonical v3 sampler emits at most one per date (A4), but noteid-targeted and
        # stacked articulations are planned for v4-v6 and are already reachable from
        # model-generated maps.
        self.artic_by_date = {}
        for a in self.articulation:
            self.artic_by_date.setdefault(a[0], []).append(a)

        #: counters describing which of meico's order-dependent code paths a render
        #: actually exercised; see the module docstring.
        self.stats = {}

        # tempo segments with meico's cumulative startDateMilliseconds. Computed here
        # rather than via tempo_math.TempoTimeline because the latter uses the platform
        # libm pow (1-ulp off from Java for ~10% of arguments); the values are otherwise
        # identical. TempoTimeline is still exposed for curve queries by eval code.
        self.tempo_segs = []
        if self.tempo:
            for i, instr in enumerate(self.tempo):
                # meico TempoMap.getEndDate(): next instruction's date, else Double.MAX_VALUE.
                # NOT infinity -- endDate is the divisor in getTempoAt(), so for a final
                # instruction with a dangling transition.to the ratio is ~1e-317 in meico but
                # would be exactly 0.0 with inf (see rubato_math.JAVA_DOUBLE_MAX).
                end = self.tempo[i + 1][0] if i + 1 < len(self.tempo) else JAVA_DOUBLE_MAX
                self.tempo_segs.append(_TempoSeg(instr, end))
            prev = None
            for seg in self.tempo_segs:
                if prev is None:                        # meico: computeDiffTiming(d, ppq, null)
                    seg.start_ms = _ms_no_tempo(seg.start)
                else:
                    seg.start_ms = _diff_timing(seg.start, prev) + prev.start_ms
                prev = seg
        self.tempo_timeline = TempoTimeline(self.tempo) if self.tempo else None

    # ------------------------------------------------------------------ public API

    def render(self, notes):
        """Render a whole score. ``notes`` is a list of (date, duration) pairs in MSM map
        order (i.e. document order, sorted by date). Returns a list of NotePerf."""
        _require_sorted(notes, "score note")            # MSM map order == date order
        self.stats = {"rubato_pending_break": 0, "rubato_pending_blocked": 0,
                      "tempo_pending_skipped": 0, "tempo_pending_revisited": 0,
                      "stacked_articulations": 0}
        out = [NotePerf(d, u) for (d, u) in notes]
        self._apply_dynamics(out)
        self._apply_articulation(out)
        self._apply_rubato(out)
        self._apply_tempo(out)
        return out

    def note_perf(self, date, duration):
        """Convenience single-note rendering. Exact whenever the note's offset is not
        affected by the ``pendingDurations`` ordering of neighbouring notes (see module
        docstring); use ``render()`` for guaranteed exactness."""
        return self.render([(date, duration)])[0]

    # ------------------------------------------------------------------ step 1: dynamics

    def _apply_dynamics(self, notes):
        if self.dyn_timeline is None:
            for n in notes:
                n.velocity = 100.0
            return
        for n in notes:
            n.velocity = self.dyn_timeline.velocity_at(n.date)

    # ------------------------------------------------------------------ step 2: articulation

    def _apply_articulation(self, notes):
        if not self.artic_by_date:
            return
        for n in notes:
            artics = self.artic_by_date.get(n.date)
            if not artics:
                continue
            if len(artics) > 1:
                self.stats["stacked_articulations"] = (
                    self.stats.get("stacked_articulations", 0) + len(artics) - 1)
            for a in artics:                    # meico applies every one, in map order
                rel_dur, vel_change = a[1], a[2]
                if rel_dur != 1.0:                              # ArticulationData.articulateNote
                    n.duration_perf = n.duration_perf * rel_dur
                if vel_change != 0.0:
                    n.velocity = n.velocity + vel_change

    # ------------------------------------------------------------------ step 3: rubato

    def _apply_rubato(self, notes):
        """Simulation of meico RubatoMap.renderRubatoToMap(score)."""
        if not self.rubato:
            return
        rt = self.rub_timeline
        n_notes = len(notes)
        map_index = 0
        pending = []                    # meico's pendingDurations: (endDateValue, noteIndex)

        for ri in range(len(rt)):
            instr = rt.instrs[ri]
            start = instr[RUB_DATE]
            end_date = rt.end_date(ri)
            loop = bool(instr[RUB_LOOP])
            frame_end = start + instr[RUB_FRAME]

            while map_index < n_notes:
                note = notes[map_index]
                key = note.date
                if key < start:                                 # continue -> ++mapIndex
                    map_index += 1
                    continue
                if (key >= end_date) or ((not loop) and (key >= frame_end)):
                    break
                note.date_perf = warp(note.date_perf, instr)
                if note.date_end_perf is not None:              # already has date.end.perf
                    pending.append((note.date_end_perf, map_index))
                else:
                    end = key + note.duration_perf              # meico uses the *map key* here
                    note.date_end_perf = end
                    pending.append((end, map_index))
                map_index += 1

            i = 0
            while i < len(pending):
                date_end, idx = pending[i]
                if (date_end >= end_date) or ((not loop) and (date_end >= frame_end)):
                    # meico BREAKS here (RubatoMap.java:392); the tempo stage continues.
                    # Count how many still-in-scope entries this abandons -- that number is
                    # the size of the divergence a `continue` would introduce, and it is 0
                    # whenever note end dates are monotone in map order.
                    self.stats["rubato_pending_break"] = (
                        self.stats.get("rubato_pending_break", 0) + 1)
                    blocked = sum(1 for (de, _) in pending[i + 1:]
                                  if de < end_date and (loop or de < frame_end))
                    self.stats["rubato_pending_blocked"] = (
                        self.stats.get("rubato_pending_blocked", 0) + blocked)
                    break
                if date_end >= start:
                    notes[idx].date_end_perf = warp(date_end, instr)
                pending.pop(i)

    # ------------------------------------------------------------------ step 4: tempo

    def _apply_tempo(self, notes):
        """Simulation of meico TempoMap.renderTempoToMap(score, ppq)."""
        if self.tempo is None:                                  # no tempoMap: 1 tick = 1 ms
            for n in notes:
                n.ms_on = n.date_perf
                if n.date_end_perf is None:
                    n.date_end_perf = n.date_perf + n.duration_perf
                n.ms_off = n.date_end_perf
            return

        if not self.tempo:                                      # empty tempoMap
            for n in notes:                                     # note: this branch of meico
                n.ms_on = _ms_no_tempo(n.date_perf)             # ignores an existing
                n.ms_off = _ms_no_tempo(n.date_perf             # date.end.perf and always
                                        + n.duration_perf)      # recomputes it from date.perf
            return

        segs = self.tempo_segs
        n_notes = len(notes)
        map_index = 0
        pending = []                    # meico's pendingDurations: (endDate, noteIndex)

        for seg in segs:
            while map_index < n_notes:
                note = notes[map_index]
                key = note.date
                if key > seg.end:
                    break
                date = note.date_perf
                if key <= seg.start:                            # before/at this instruction
                    note.ms_on = _ms_no_tempo(date)
                else:
                    note.ms_on = _diff_timing(date, seg) + seg.start_ms
                if note.date_end_perf is not None:
                    pending.append((note.date_end_perf, map_index))
                else:
                    end = date + note.duration_perf             # meico uses date.perf here
                    note.date_end_perf = end
                    pending.append((end, map_index))
                map_index += 1

            i = 0
            skipped = 0
            while i < len(pending):
                date_end, idx = pending[i]
                if date_end > seg.end:
                    # meico CONTINUES here (TempoMap.java:426); the rubato stage breaks.
                    i += 1
                    skipped += 1
                    self.stats["tempo_pending_skipped"] = (
                        self.stats.get("tempo_pending_skipped", 0) + 1)
                    continue
                if skipped:                                     # reached only thanks to the
                    self.stats["tempo_pending_revisited"] = (   # continue; a break would
                        self.stats.get("tempo_pending_revisited", 0) + 1)   # have missed it
                if date_end <= seg.start:
                    notes[idx].ms_off = _ms_no_tempo(date_end)
                else:
                    notes[idx].ms_off = _diff_timing(date_end, seg) + seg.start_ms
                pending.pop(i)

            if (map_index >= n_notes) and not pending:
                break
