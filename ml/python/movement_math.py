"""Exact Python port of meico's movementMap rendering (pedalling / arbitrary CC curves).

Mirrors, line for line:

  * ``meico/mpm/elements/maps/data/MovementData.java``  (post-1b3711f0: ``curvature`` /
    ``protraction`` / ``controller`` are parsed rather than silently defaulted)
  * ``meico/mpm/elements/maps/MovementMap.java``        (``renderMovementToMap``,
    ``getMovementDataOf``, ``getPreviousPosition``, ``getEndDate``, ``generateMovement``)
  * cross-checked against the espressivo TS port
    (``meico-ts/src/mpm/elements/maps/MovementMap.ts``, ``.../data/MovementData.ts``,
    ``.../data/bezier.ts``), which reproduces the same code bug-for-bug by design.

WHAT MOVEMENT RENDERING IS.  A ``<movement>`` is a transition of a continuous MIDI
controller (``controller="sustain"`` -> CC 64, ``"soft"`` -> CC 67, anything else -> CC 0)
from ``position`` to ``transition.to`` over the span that reaches to the *next* movement
instruction.  Rendering does not touch the score at all: ``MovementMap.renderMovementToMap``
builds a **new** ``positionMap`` of ``<position date value controller/>`` elements by
sampling the curve, and ``Performance.perform`` then puts that map through the tempo map and
the asynchrony map (``Performance.java:514-519, 541-543``) exactly like any other MSM map.
Only the tick->ms half of that lives here; see ``perf_chain_v4`` for the composition.

THE CURVE is the same cubic S-shaped Bezier as continuous dynamics -- ``x1``/``x2`` from
``curvature``/``protraction``, value ``(3-2t)t^2`` -- so ``inner_control_points`` is imported
from ``dynamics_math`` rather than duplicated (meico-ts merged the two copies into
``bezier.ts`` after finding them byte-identical).  What is *not* shared is
``get_movement_segment``: it samples adaptively in the **normalized 0..1 value domain**
against ``max_step_size`` and scales the result by 127 only at the very end.

Six behaviours here are quirks of the reference, not design, and every one of them is
observable in a rendered ``positionMap``.  They are reproduced deliberately:

  Q1  the **last** movement instruction of a map is never rendered
      (``movementIndex < this.size() - 1``); it exists only as the target the previous
      transition aims at.  A map of one instruction renders nothing at all.
  Q2  ``getPreviousPosition`` loops ``for (j = index-1; j > 0; --j)`` -- **index 0 is never
      examined**, so a movement that inherits its ``position`` from the very first entry of
      the map inherits 0.0 instead of that entry's ``transition.to``.  (Verified against the
      Java fork: a two-instruction map ``0 -> 1.0`` then position-less ``-> 0.2`` starts its
      second ramp at 0, not at 1.0.)
  Q3  the sampled series is bracketed by an *exact* start point (unshifted onto the front)
      and an exact end point (appended), while the subdivision already produced samples at
      t=0 and t=1 that coincide with them -- so **the first and the last point of every
      rendered segment are duplicated**.  MIDI export does not dedupe them.
  Q4  a movement with no ``transition.to`` is constant: ``getDatePosition`` returns the start
      point for every ``t``, so the subdivision never fires and the segment is exactly three
      identical points (t=0, t=1, prepended start) with no appended end point.
  Q5  ``curvature`` and ``protraction`` are **not** clamped on parse (unlike DynamicsMap's
      ``ensureCurvatureBoundaries`` / ``ensureProtractionBoundaries``), so a curvature outside
      [0,1] yields a non-monotone x(t) and the generated events are *not* in date order.
      ``GenericMap.insertElement(kv, false)`` then reorders them, stably, after equal keys --
      which ``MovementTimeline.render_to_position_map`` mirrors instead of assuming order.
  Q6  the defaults come from the ``MovementData`` **field initialisers**, which
      ``getMovementDataOf`` only overwrites when the attribute is present:
      ``curvature=0.4``, ``protraction=0.0``, ``controller="sustain"``, ``position=0.0``.
      A movementMap written without ``curvature`` therefore renders a 0.4-curvature S, not a
      straight line.

Row format (the JSONL / map-row convention the other ports use)::

    [date, position | None, transition_to | None, curvature | None, protraction | None,
     controller | None]

``None`` means *the attribute is absent from the XML*, which is what selects the Q2/Q6
fallbacks -- it is not the same as writing the default value out.  Short rows are padded
with ``None``.

Floating point: this module needs no transcendental function at all (the Bezier is
polynomial and the t-search is a bisection), so there is nothing to route through
``java_libm``; the tempo composition in ``perf_chain_v4`` does that.  Every expression below
keeps the reference's exact association order -- ``((u*t + v)*t + w) * t * s`` is Horner and
is *not* equal in IEEE-754 to the expanded polynomial.
"""

from dynamics_math import inner_control_points
from java_libm import JAVA_DOUBLE_MAX

__all__ = ["MOV_DATE", "MOV_POSITION", "MOV_TRANSITION_TO", "MOV_CURVATURE",
           "MOV_PROTRACTION", "MOV_CONTROLLER", "MOV_ROW_LEN",
           "DEFAULT_CURVATURE", "DEFAULT_PROTRACTION", "DEFAULT_CONTROLLER",
           "DEFAULT_POSITION", "DEFAULT_MOVEMENT_SAMPLE_MAX_STEP",
           "CC_SUSTAIN", "CC_SOFT", "cc_number_of",
           "MovementData", "PositionEvent", "MovementTimeline"]

# ---------------------------------------------------------------- row layout / defaults

MOV_DATE = 0
MOV_POSITION = 1
MOV_TRANSITION_TO = 2
MOV_CURVATURE = 3
MOV_PROTRACTION = 4
MOV_CONTROLLER = 5
MOV_ROW_LEN = 6

#: MovementData field initialisers (Q6) -- NOT the XML defaults of the MPM schema.
DEFAULT_POSITION = 0.0
DEFAULT_CURVATURE = 0.4
DEFAULT_PROTRACTION = 0.0
DEFAULT_CONTROLLER = "sustain"

#: MovementMap.movementSampleMaxStep, in the normalized 0..1 position domain.
DEFAULT_MOVEMENT_SAMPLE_MAX_STEP = 0.1

CC_SUSTAIN = 64                 # EventMaker.CC_Damper_Pedal
CC_SOFT = 67                    # EventMaker.CC_Soft_Pedal


def cc_number_of(controller):
    """``Msm.parsePositionMap`` / espressivo ``ccNumberOf``: sustain->64, soft->67, else 0."""
    if controller == "sustain":
        return CC_SUSTAIN
    if controller == "soft":
        return CC_SOFT
    return 0


# ---------------------------------------------------------------- MovementData.java

class MovementData:
    """One ``<movement>`` plus the ``endDate`` only the map knows.

    ``end_date`` is ``JAVA_DOUBLE_MAX`` for the final instruction, exactly as meico's
    ``getEndDate`` returns ``Double.MAX_VALUE`` (never infinity -- it is a divisor).
    """

    __slots__ = ("start_date", "end_date", "position", "transition_to",
                 "curvature", "protraction", "controller", "x1", "x2")

    def __init__(self, start_date, end_date, position, transition_to,
                 curvature=None, protraction=None, controller=None):
        self.start_date = float(start_date)
        self.end_date = float(end_date)
        self.position = None if position is None else float(position)
        self.transition_to = None if transition_to is None else float(transition_to)
        # Q6: absent attribute -> the field initialiser, not 0.
        self.curvature = DEFAULT_CURVATURE if curvature is None else float(curvature)
        self.protraction = DEFAULT_PROTRACTION if protraction is None else float(protraction)
        self.controller = DEFAULT_CONTROLLER if controller is None else str(controller)
        self.x1 = None
        self.x2 = None

    def is_constant_movement(self):
        return self.transition_to is None

    # -- MovementData.computeInnerControlPointsXPositions()
    def _compute_inner_control_points(self):
        # meico defaults a *null* curvature/protraction to 0.0 here, in place. That path is
        # only reachable through the MovementData(Element) constructor, where the fields can
        # be explicitly nulled; via getMovementDataOf they are never null (Q6). Kept for
        # fidelity, and because the in-place write is visible to a later clone().
        if self.curvature is None:
            self.curvature = 0.0
        if self.protraction is None:
            self.protraction = 0.0
        self.x1, self.x2 = inner_control_points(self.curvature, self.protraction)

    # -- MovementData.getTForDate(date)
    def t_for_date(self, date):
        """Bisection inverse of the Bezier's x-component, tick-precise (|dx| < 1).

        Not used by ``get_movement_segment`` (which walks t directly) -- only by
        ``position_at``. Reproduces the reference's non-terminating behaviour for a
        degenerate span rather than guarding it, so a divergence cannot hide as a guard.
        """
        if date == self.start_date:
            return 0.0
        if date == self.end_date:
            return 1.0
        if self.x1 is None:
            self._compute_inner_control_points()
        s = self.end_date - self.start_date
        d = date - self.start_date
        u = (3.0 * self.x1) - (3.0 * self.x2) + 1.0
        v = (-6.0 * self.x1) + (3.0 * self.x2)
        w = 3.0 * self.x1
        t = 0.5
        diff_x = ((((u * t) + v) * t + w) * t * s) - d
        tt = 0.25
        while abs(diff_x) >= 1.0:
            if diff_x > 0.0:
                t -= tt
            else:
                t += tt
            diff_x = ((((u * t) + v) * t + w) * t * s) - d
            tt *= 0.5
        return t

    # -- MovementData.getPositionAt(date)
    def position_at(self, date):
        """Normalized 0..1 position at ``date``. NOT part of the render path (meico never
        calls it during ``perform``); exposed for curve queries by eval code."""
        if date <= self.start_date or self.position is None:
            return self.position
        if date >= self.end_date:
            return self.transition_to
        t = self.t_for_date(date)
        return ((((3.0 - (2.0 * t)) * t * t) * (self.transition_to - self.position))
                + self.position)

    # -- MovementData.getDatePosition(t)
    def date_position(self, t):
        """``[date, value]`` on the curve at parameter ``t``; value still normalized 0..1."""
        if self.transition_to is None:                      # Q4
            return [self.start_date, self.position]
        x1_3 = 3.0 * self.x1
        x2_3 = 3.0 * self.x2
        u = x1_3 - x2_3 + 1.0
        v = (-6.0 * self.x1) + x2_3
        frame_start = self.start_date
        frame_length = self.end_date - self.start_date
        return [((((u * t) + v) * t + x1_3) * t * frame_length) + frame_start,
                ((((3.0 - (2.0 * t)) * t * t) * (self.transition_to - self.position))
                 + self.position)]

    # -- MovementData.getMovementSegment(maxStepSize)
    def get_movement_segment(self, max_step_size=DEFAULT_MOVEMENT_SAMPLE_MAX_STEP):
        """``[[date_ticks, value_0_127], ...]`` for this one movement.

        ``max_step_size`` is compared in the **normalized** value domain; the x127 scaling
        happens after the subdivision (feeding a 0..127 threshold is meico-ts'
        "16129 bug"). Bracketing/duplication per Q3, constant case per Q4.
        """
        if self.x1 is None:
            self._compute_inner_control_points()

        ts = [0.0, 1.0]
        series = [self.date_position(0.0), self.date_position(1.0)]

        # Depth-first subdivision. Both bounds are re-read every iteration: the lists grow
        # underneath the loop, and the ``while`` re-tests the *same* index pair, halving one
        # gap repeatedly until it is small enough.
        i = 0
        while i < len(ts) - 1:
            while abs(series[i + 1][1] - series[i][1]) > max_step_size:
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


# ---------------------------------------------------------------- MovementMap.java

class PositionEvent:
    """One ``<position>`` element of the rendered positionMap (tick domain)."""

    __slots__ = ("date", "value", "controller")

    def __init__(self, date, value, controller):
        self.date = date
        self.value = value
        self.controller = controller

    def __repr__(self):
        return "PositionEvent(date=%r, value=%r, controller=%r)" % (
            self.date, self.value, self.controller)

    def __eq__(self, other):
        return (isinstance(other, PositionEvent) and other.date == self.date
                and other.value == self.value and other.controller == self.controller)

    def __hash__(self):
        return hash((self.date, self.value, self.controller))


class MovementTimeline:
    """A movementMap: rows ``[date, position, transition_to, curvature, protraction,
    controller]`` (``None`` = attribute absent), sorted by date."""

    def __init__(self, movement_map):
        rows = []
        for r in (movement_map or []):
            row = list(r)
            if len(row) > MOV_ROW_LEN:
                raise ValueError("movement row has %d fields, expected at most %d: %r"
                                 % (len(row), MOV_ROW_LEN, r))
            row += [None] * (MOV_ROW_LEN - len(row))
            row[MOV_DATE] = float(row[MOV_DATE])
            rows.append(row)
        for i in range(1, len(rows)):
            if rows[i][MOV_DATE] < rows[i - 1][MOV_DATE]:
                raise ValueError("movement map is not sorted by date: row %d (date %s) "
                                 "precedes row %d (date %s)"
                                 % (i, rows[i][MOV_DATE], i - 1, rows[i - 1][MOV_DATE]))
        self.instrs = rows

    def __len__(self):
        return len(self.instrs)

    # -- MovementMap.getEndDate(index)
    def end_date(self, index):
        if index + 1 < len(self.instrs):
            return self.instrs[index + 1][MOV_DATE]
        return JAVA_DOUBLE_MAX

    # -- MovementMap.getPreviousPosition(index)
    def previous_position(self, index):
        """Q2 verbatim: the scan stops at ``j > 0``, so entry 0 is never examined."""
        final_position = 0.0
        for j in range(index - 1, 0, -1):
            tt = self.instrs[j][MOV_TRANSITION_TO]
            if tt is None:
                # Java: getAttribute("transition.to").getValue() on a null attribute ->
                # NullPointerException. (espressivo diverges here and leaves 0.0; that is a
                # documented malformed-input-only difference, MovementMap.ts:117-137.)
                raise ValueError(
                    "movement row %d inherits its position from row %d, which has no "
                    "transition.to; meico throws a NullPointerException here" % (index, j))
            final_position = float(tt)
            break
        return final_position

    # -- MovementMap.getMovementDataOf(index)
    def movement_data_of(self, index):
        if not self.instrs or index < 0:
            return None
        if index >= len(self.instrs):
            index = len(self.instrs) - 1
        row = self.instrs[index]
        position = row[MOV_POSITION]
        if position is None:
            position = self.previous_position(index)
        return MovementData(start_date=row[MOV_DATE],
                            end_date=self.end_date(index),
                            position=position,
                            transition_to=row[MOV_TRANSITION_TO],
                            curvature=row[MOV_CURVATURE],
                            protraction=row[MOV_PROTRACTION],
                            controller=row[MOV_CONTROLLER])

    # -- MovementMap.renderMovementToMap() + generateMovement()
    def render_to_position_map(self, max_step_size=DEFAULT_MOVEMENT_SAMPLE_MAX_STEP):
        """The rendered positionMap, as a list of :class:`PositionEvent` in map order.

        Map order is ``GenericMap.insertElement(kv, false)`` order -- a stable insertion
        sort that places an equal-keyed newcomer *after* its equals. For a monotone curve
        that is just generation order; for Q5's non-monotone one it is not, so the insertion
        is mirrored rather than assumed.
        """
        out = []
        n = len(self.instrs)
        for movement_index in range(n):
            md = self.movement_data_of(movement_index)
            if md is None:
                continue
            if movement_index < (n - 1) and md.start_date >= 0:     # Q1 + negative-date skip
                for date, value in md.get_movement_segment(max_step_size):
                    _insert_element(out, PositionEvent(date, value, md.controller))
        return out


def _insert_element(entries, event):
    """``GenericMap.insertElement(element, firstAtDate=false)``.

    Scans from the back for the last entry with ``key <= newKey`` and inserts after it;
    inserts at the front when there is none (empty map, all keys greater, or a NaN key --
    every ``<=`` comparison against NaN is false in Java and in Python alike).
    """
    for i in range(len(entries) - 1, -1, -1):
        if entries[i].date <= event.date:
            entries.insert(i + 1, event)
            return i + 1
    entries.insert(0, event)
    return 0
