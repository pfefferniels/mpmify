"""The v4 per-part rendering chain: v3's four maps + movementMap + asynchronyMap.

``PerfChainV4`` is a thin, exact wrapper around :class:`perf_chain.PerfChain`. It adds the
three things v4 needs and v3 did not have:

  1. **per-part rendering** -- ``Performance.perform`` loops over the MSM parts and resolves
     every map as "the part's own map, else the global one" (``Performance.java:463-503``);
     rendered notes carry the part number;
  2. **movementMap** -> a sampled ``positionMap`` control-change stream (``movement_math``),
     put through the tempo map and the asynchrony map like any other MSM map;
  3. **asynchronyMap** -> constant millisecond offsets on the score, the positionMap and the
     channelVolumeMap (``asynchrony_math``).

ORDER OF OPERATIONS, verbatim from ``Performance.perform`` (``Performance.java:505-555``),
for each part::

    1  DynamicsMap.renderDynamicsToMap(score, dynamicsMap)      -> velocity, channelVolumeMap
    2  MovementMap.renderMovementToMap(movementMap)             -> positionMap   (tick domain)
    3  MetricalAccentuationMap.render...                        -- OUT OF SCOPE (v4 gate)
    4  ArticulationMap.render..._noMillisecondModifiers(score)  -> duration.perf, velocity
    5  RubatoMap.renderRubatoToMap(score)                       -> date.perf, date.end.perf
    6  OrnamentationMap.render...                               -- OUT OF SCOPE
    7  TempoMap.renderTempoToMap(score)                         -> milliseconds.date(.end)
    8  Asynchrony/Imprecision on the pedalMap                   -- no MSM pedalMap here
    9  TempoMap then AsynchronyMap on the channelVolumeMap
   10  TempoMap then AsynchronyMap on the positionMap
   11  AsynchronyMap.renderAsynchronyToMap(score)
   12  articulation ms modifiers / ornamentation ms / imprecision -- OUT OF SCOPE

Steps 1 and 4-7 are exactly what ``PerfChain.render`` already does bit-exactly, so they are
delegated, not re-implemented. Note that steps 9 and 10 do **not** go through the rubato map
(meico deliberately keeps rubato out of the controller curves) and that each
``renderAsynchronyToMap`` call gets its own working list, so the three applications are
independent.

ARTICULATION TARGETING.  Step 4 is delegated to a :class:`_ScoreChain` subclass rather than
to ``PerfChain`` unchanged, because v4 exposes a meico behaviour v3 could not reach: a
``noteid``-less ``<articulation>`` whose date carries **no note** is not skipped -- it
articulates the *next* note (and, if that is a chord, only its first note). ``PerfChain``
matches by exact date, which is equivalent for every v3 dataset and wrong for v4, whose
articulation dates come from the union of both parts' onsets while the map is global. See
:class:`_ScoreChain` for the reference citation and the measured impact.

THE channelVolumeMap.  Even with no sub-note dynamics, ``DynamicsMap.renderDynamicsToMap``
returns a channelVolumeMap containing **one** ``<volume date=<first dynamics date>
value="100.0" mandatory="true"/>`` event (``DynamicsMap.java``, the
``chanVolMap.isEmpty() || last value != "100.0"`` branch): it resets the MIDI channel-volume
slider to its default so that note velocities alone carry the loudness. Every later
instruction finds the last value already at 100.0 and adds nothing. That single event is a
real control-change point in the rendered output -- espressivo reports it as a
``channelVolume`` stream -- so it is produced here too. Sub-note dynamics (which would emit a
*curve* into that map) are outside the canonical form and rejected explicitly.

THE EMPTY dynamicsMap (D0).  ``DynamicsMap.renderDynamicsToMap(map)`` returns ``null``
*before writing anything* when ``this.elements.isEmpty()`` (``DynamicsMap.java:392-394``), so
an **empty but present** ``<dynamicsMap/>`` leaves every note without a ``velocity``
attribute at all -- which is a different state from "no dynamicsMap", where the static
overload (``DynamicsMap.java:462-480``) explicitly writes ``velocity="100.0"`` on every note.
The difference is observable downstream: ``ArticulationData.articulateNote`` guards its three
velocity modifiers with ``if (velocityAtt != null)`` (``ArticulationData.java:209``), so with
an empty dynamicsMap an articulation still scales ``duration.perf`` but its
``absoluteVelocityChange`` is silently dropped.  :class:`_ScoreChain` reproduces both states:
an empty map renders ``NotePerf.velocity = None`` ("attribute absent").

CURVATURE / PROTRACTION CLAMPING (D1).  The fork clamps dynamics ``curvature`` to [0, 1] and
``protraction`` to [-1, 1] **at render time**, inside ``getDynamicsDataOf``
(``DynamicsMap.java:346, 350`` -> ``ensureCurvatureBoundaries`` / ``ensureProtractionBoundaries``),
not only on the write path. ``dynamics_math.inner_control_points`` applies no bounds, so
:class:`_ScoreChain` clamps the rows it hands down. This is the exact *opposite* of the
movementMap, whose ``getMovementDataOf`` genuinely does not clamp (``MovementMap.java:182-192``,
quirk Q5 in ``movement_math``) -- the asymmetry is real and both halves are under test.

Part specification (a plain dict)::

    {"number": 1, "name": "Piano",
     "notes": [[date, duration, ...], ...],          # extra fields ignored; map order
     "tempo": [...], "dynamics": [...], "articulation": [...], "rubato": [...],
     "movement": [...], "asynchrony": [...]}

**Map resolution follows meico literally**: ``Performance.java:479-494`` is six times
``if (localMap == null) localMap = globalMap;`` -- a *null* local map ALWAYS inherits, and
meico has no "this part has a null map" state at all. So a key that is absent from the part
dict, a key whose value is ``None`` and :data:`INHERIT` all mean the same thing: use the
global map. Only ``[]`` (an empty but *present* map element) shadows the global one. A
``None`` global map is genuinely "no such map anywhere", which for ``tempo`` selects meico's
1-tick-=-1-ms fallback and for ``dynamics`` its explicit ``velocity="100.0"`` default.

Floating point: every transcendental call reaches Java's fdlibm through
``perf_chain``/``java_libm``; nothing here introduces a new one.

NOT REPRESENTABLE (and therefore not validated): ``<style>`` elements interleaved into any of
these maps. The row formats are positional and carry no element-kind field, and in meico a
trailing ``<style>`` in a movementMap makes the last *movement* renderable, flipping Q1. A
map containing styles must not be pushed through this chain.
"""

from asynchrony_math import AsynchronyEntry, AsynchronyTimeline
from movement_math import (DEFAULT_MOVEMENT_SAMPLE_MAX_STEP, MovementTimeline,  # noqa: F401
                           cc_number_of)
from perf_chain import NotePerf, PerfChain
# meico's own tick->ms primitives, already proven bit-exact by validate_v3; importing them
# (rather than re-deriving) is what keeps v4 exact by construction.
from perf_chain import _diff_timing, _ms_no_tempo  # noqa: PLC2701
from perf_chain import _index_at_after as _pc_index_at_after  # noqa: PLC2701

__all__ = ["INHERIT", "MAP_KEYS", "CCPoint", "CCStream", "NoteV4", "PartPerf", "PerfChainV4"]


class _Inherit:
    __slots__ = ()

    def __repr__(self):
        return "INHERIT"


#: sentinel for "this part has no local map of this type; use the global one".  ``None`` and
#: an absent key mean exactly the same thing (``Performance.java:479-494``); the sentinel only
#: exists so a caller can spell the intent out.
INHERIT = _Inherit()

MAP_KEYS = ("tempo", "dynamics", "articulation", "rubato", "movement", "asynchrony")

CC_CHANNEL_VOLUME = 7           # EventMaker.CC_Channel_Volume


# ---------------------------------------------------------------------------- results

class NoteV4(NotePerf):
    """A :class:`perf_chain.NotePerf` that knows which part it came from."""

    __slots__ = ("part", "index")

    @classmethod
    def of(cls, note, part, index):
        n = cls(note.date, note.duration)
        for slot in NotePerf.__slots__:
            setattr(n, slot, getattr(note, slot))
        n.part = part
        n.index = index
        return n

    def __repr__(self):
        return ("NoteV4(part=%s, i=%s, date=%s, dur=%s, ms_on=%s, ms_off=%s, vel=%s)"
                % (self.part, self.index, self.date, self.duration, self.ms_on,
                   self.ms_off, self.velocity))


class CCPoint:
    """One rendered control-change event: symbolic date, millisecond date, 0..127 value.

    ``controller`` is the MPM controller name for positionMap events and ``None`` for
    channelVolume ones -- it is carried on the point (not only on the stream) so that
    :attr:`PartPerf.positions`, which is the flat map-order positionMap, stays complete.
    """

    __slots__ = ("date", "ms", "value", "controller")

    def __init__(self, date, ms, value, controller=None):
        self.date = date
        self.ms = ms
        self.value = value
        self.controller = controller

    def as_tuple(self):
        return (self.date, self.ms, self.value)

    def __repr__(self):
        return ("CCPoint(date=%r, ms=%r, value=%r, controller=%r)"
                % (self.date, self.ms, self.value, self.controller))


class CCStream:
    """A control-change stream, shaped like espressivo's ``ControlChangeStream``.

    ``kind``        ``"channelVolume"`` (sub-note dynamics slider) or ``"position"``
                    (movement / pedalling)
    ``controller``  the MPM ``controller`` name for ``position`` streams, ``None`` otherwise
    ``cc_number``   64 (sustain), 67 (soft), 7 (channelVolume), 0 (unrecognised)
    ``points``      list of :class:`CCPoint` in map order
    """

    __slots__ = ("kind", "controller", "cc_number", "points")

    def __init__(self, kind, controller, cc_number, points):
        self.kind = kind
        self.controller = controller
        self.cc_number = cc_number
        self.points = points

    def ms_value_points(self):
        """``[(ms, value), ...]`` -- the sampled CC stream as the v4 evaluator consumes it."""
        return [(p.ms, p.value) for p in self.points]

    def __repr__(self):
        return ("CCStream(kind=%r, controller=%r, cc=%d, %d points)"
                % (self.kind, self.controller, self.cc_number, len(self.points)))


class PartPerf:
    """Everything one MSM part renders to.

    ``notes``      :class:`NoteV4` in MSM map order
    ``positions``  the rendered **positionMap**, flat, in map order -- the ground truth an
                   MSM comparison is made against. Interleaved controllers stay interleaved
                   here; ``cc`` is the grouped view.
    ``volumes``    the rendered **channelVolumeMap**, flat, in map order
    ``cc``         :class:`CCStream` list in espressivo's order: the channelVolume stream
                   first, then one position stream per controller in first-appearance order
    """

    __slots__ = ("index", "number", "name", "notes", "positions", "volumes", "cc", "stats")

    def __init__(self, index, number, name, notes, positions, volumes, cc, stats):
        self.index = index
        self.number = number
        self.name = name
        self.notes = notes
        self.positions = positions
        self.volumes = volumes
        self.cc = cc
        self.stats = stats

    def stream(self, kind=None, controller=None):
        """The first stream matching ``kind`` / ``controller``, or ``None``."""
        for s in self.cc:
            if (kind is None or s.kind == kind) and (controller is None
                                                     or s.controller == controller):
                return s
        return None

    def __repr__(self):
        return ("PartPerf(index=%d, number=%s, name=%r, %d notes, %d positions, "
                "%d cc streams)" % (self.index, self.number, self.name, len(self.notes),
                                    len(self.positions), len(self.cc)))


# ------------------------------------------------------------- tempo on a duration-less map

def _render_tempo_to_dateless_map(chain, keys):
    """``TempoMap.renderTempoToMap`` for a map whose elements carry neither ``duration`` nor
    ``date.end`` -- the positionMap and the channelVolumeMap.

    ``date.perf == date`` for both maps (neither is touched by rubato), so the map key *is*
    the date the curve is evaluated at. ``pendingDurations`` therefore stays empty and the
    whole ``date.end.perf`` half of the reference loop is unreachable; everything else --
    the ``key > endDate`` break, the ``key <= startDate`` no-tempo branch, the cumulative
    ``startDateMilliseconds`` -- is mirrored exactly.

    ``keys`` must be in map order (non-decreasing). Returns one millisecond value per key.
    """
    n = len(keys)
    out = [None] * n
    if n == 0:
        return out

    if chain.tempo is None:                     # static renderTempoToMap(map, ppq, null):
        for i, k in enumerate(keys):            # milliseconds.date := date.perf verbatim
            out[i] = k
        return out

    if not chain.tempo:                         # empty tempoMap branch (fixed 100 bpm)
        for i, k in enumerate(keys):
            out[i] = _ms_no_tempo(k)
        return out

    map_index = 0
    for seg in chain.tempo_segs:
        while map_index < n:
            key = keys[map_index]
            if key > seg.end:
                break
            if key <= seg.start:
                out[map_index] = _ms_no_tempo(key)
            else:
                out[map_index] = _diff_timing(key, seg) + seg.start_ms
            map_index += 1
        if map_index >= n:                      # pendingDurations is always empty here
            break
    return out


# ------------------------------------------------------------------ channelVolumeMap

def _channel_volume_map(dynamics):
    """``DynamicsMap.renderDynamicsToMap``'s channelVolumeMap for a canonical dynamics map.

    Returns ``[]`` when there is no dynamicsMap or it is empty (meico returns ``null`` and
    the part gets no channelVolumeMap at all), otherwise the single mandatory
    ``value=100.0`` reset event at the first instruction's date.
    """
    if not dynamics:
        return []
    # The reference re-checks ``last value != "100.0"`` for every instruction; only a
    # sub-note-dynamics segment can put a different value there, and sub-note dynamics is
    # not representable in the canonical row format (and is refused in __init__).
    return [(float(dynamics[0][0]), 100.0)]


# ---------------------------------------------------------------------------- the chain

class PerfChainV4:
    """Compose v4's six maps into meico's per-part rendering chain.

    ``parts``        list of part dicts (see the module docstring)
    ``global_maps``  dict of the global maps, same keys, no ``notes``
    ``movement_sample_max_step``  ``MovementMap.movementSampleMaxStep`` (default 0.1)
    """

    def __init__(self, parts, global_maps=None, movement_sample_max_step=None):
        if isinstance(parts, dict):
            parts = [parts]
        self.parts = [dict(p) for p in parts]
        self.global_maps = dict(global_maps or {})
        self.max_step = (DEFAULT_MOVEMENT_SAMPLE_MAX_STEP
                         if movement_sample_max_step is None else movement_sample_max_step)

        for src, what in ([(self.global_maps, "global")]
                          + [(p, "part %d" % i) for i, p in enumerate(self.parts)]):
            for row in (src.get("dynamics") or []):
                if len(row) > 5 and row[5]:
                    raise NotImplementedError(
                        "%s dynamicsMap row %r requests subNoteDynamics; that emits a "
                        "channelVolume *curve* and is outside the v4 canonical form"
                        % (what, row))

        #: aggregate counters (PerfChain's order-dependent paths + asynchrony's)
        self.stats = {}

    # -------------------------------------------------------------------- map resolution

    def _resolve(self, part):
        """meico: ``if (localMap == null) localMap = globalMap;`` (Performance.java:479-494).

        A local map that is ``None`` -- absent key, explicit ``None``, or :data:`INHERIT` --
        inherits the global one. meico has no state in which a part holds a *null* map that
        shadows the global: the null check IS the inheritance. Treating ``None`` as "local
        null map" would silently select the no-tempoMap fallback for ``spec['tempo'] = None``
        and drop a global movementMap for ``spec['movement'] = None``.  Only ``[]`` -- an
        empty but present map element -- shadows.
        """
        out = {}
        for k in MAP_KEYS:
            v = part.get(k, INHERIT)
            out[k] = self.global_maps.get(k) if (v is None or isinstance(v, _Inherit)) else v
        return out

    # ---------------------------------------------------------------------------- render

    def render(self):
        """Render every part. Returns a list of :class:`PartPerf` in part order."""
        self.stats = {}
        results = []

        for index, part in enumerate(self.parts):
            maps = self._resolve(part)
            raw_notes = list(part.get("notes") or [])
            notes_in = [(n[0], n[1]) for n in raw_notes]

            # ---- steps 1 + 4..7: dynamics, articulation, rubato, tempo on the score
            chain = _ScoreChain(tempo=maps["tempo"], dynamics=maps["dynamics"],
                                articulation=maps["articulation"], rubato=maps["rubato"],
                                dynamics_present=maps["dynamics"] is not None)
            rendered = chain.render(notes_in)
            notes = [NoteV4.of(n, part.get("number", index + 1), i)
                     for i, n in enumerate(rendered)]
            part_stats = dict(chain.stats)

            asyn = AsynchronyTimeline(maps["asynchrony"] or [])

            # ---- step 9: channelVolumeMap -- tempo, then asynchrony
            cvm = _channel_volume_map(maps["dynamics"])
            cvm_ms = _render_tempo_to_dateless_map(chain, [d for (d, _) in cvm])
            cvm_entries = [AsynchronyEntry(key=d, duration=None, ms_date=ms)
                           for (d, _), ms in zip(cvm, cvm_ms)]
            asyn.render(cvm_entries)
            _merge_stats(part_stats, asyn.stats, "asyn_cvm_")

            # ---- step 10: positionMap -- movement sampling, tempo, then asynchrony
            movement = maps["movement"]
            positions = (MovementTimeline(movement).render_to_position_map(self.max_step)
                         if movement else [])
            pos_ms = _render_tempo_to_dateless_map(chain, [p.date for p in positions])
            pos_entries = [AsynchronyEntry(key=p.date, duration=None, ms_date=ms)
                           for p, ms in zip(positions, pos_ms)]
            asyn.render(pos_entries)
            _merge_stats(part_stats, asyn.stats, "asyn_pos_")

            # ---- step 11: the score -- asynchrony last
            score_entries = [AsynchronyEntry(key=n.date, duration=n.duration,
                                             ms_date=n.ms_on, ms_end=n.ms_off, payload=n)
                             for n in notes]
            asyn.render(score_entries)
            _merge_stats(part_stats, asyn.stats, "asyn_score_")
            for e in score_entries:
                e.payload.ms_on = e.ms_date
                e.payload.ms_off = e.ms_end

            # ---- assemble the control-change points: flat map order first ...
            volumes = [CCPoint(e.key, e.ms_date, v, None)
                       for e, (_, v) in zip(cvm_entries, cvm)]
            flat_positions = [CCPoint(p.date, e.ms_date, p.value, p.controller)
                              for p, e in zip(positions, pos_entries)]

            # ... then espressivo's grouped view (readControlChanges): the channelVolume
            # stream, then one position stream per controller in first-appearance order.
            # Grouping is a stable partition of `flat_positions`, so no point is lost or
            # reordered within a stream.
            cc = []
            if volumes:
                cc.append(CCStream("channelVolume", None, CC_CHANNEL_VOLUME, volumes))
            by_controller = {}                  # dicts preserve first-insertion order
            for p in flat_positions:
                by_controller.setdefault(p.controller, []).append(p)
            for controller, points in by_controller.items():
                cc.append(CCStream("position", controller, cc_number_of(controller), points))

            results.append(PartPerf(index=index, number=part.get("number", index + 1),
                                    name=part.get("name"), notes=notes,
                                    positions=flat_positions, volumes=volumes, cc=cc,
                                    stats=part_stats))
            _merge_stats(self.stats, part_stats, "")

        return results

    def render_notes(self):
        """Flat list of :class:`NoteV4` over all parts, in part then map order."""
        return [n for p in self.render() for n in p.notes]


def _merge_stats(target, source, prefix):
    for k, v in source.items():
        key = prefix + k
        target[key] = target.get(key, 0) + v


# ------------------------------------------------------------ dynamics boundary clamping

def _ensure_curvature_boundaries(curvature):
    """``DynamicsMap.ensureCurvatureBoundaries`` (DynamicsMap.java:249-259): clamp to [0, 1].

    Written as two one-sided comparisons rather than ``min``/``max`` so that NaN falls
    through unchanged, exactly as it does in Java (every comparison against NaN is false).
    """
    if curvature < 0.0:
        return 0.0
    if curvature > 1.0:
        return 1.0
    return curvature


def _ensure_protraction_boundaries(protraction):
    """``DynamicsMap.ensureProtractionBoundaries`` (DynamicsMap.java:266-276): [-1, 1]."""
    if protraction < -1.0:
        return -1.0
    if protraction > 1.0:
        return 1.0
    return protraction


def _clamped_dynamics(rows):
    """Apply the fork's render-time clamps to a dynamicsMap's rows.

    ``getDynamicsDataOf`` clamps ``curvature``/``protraction`` where it *parses* them, which
    is inside the ``transition.to != null`` branch; when ``transition.to`` is absent both are
    forced to 0.0 and the value in the row is never read (``dynamics_math.dynamics_at``
    returns the constant volume). Clamping unconditionally is therefore equivalent and keeps
    the row shape uniform. Returns new rows; the caller's lists are never mutated.
    """
    out = []
    clamped = 0
    for row in rows:
        row = list(row)
        if len(row) > 3 and row[3] is not None:
            c = _ensure_curvature_boundaries(float(row[3]))
            clamped += (c != row[3])
            row[3] = c
        if len(row) > 4 and row[4] is not None:
            p = _ensure_protraction_boundaries(float(row[4]))
            clamped += (p != row[4])
            row[4] = p
        out.append(row)
    return out, clamped


# ------------------------------------------------- articulation targeting (meico quirk A6)

#: ``GenericMap.getElementIndexAtAfter``. Lives in :mod:`perf_chain` since the A6 targeting
#: rule became available there too (a *predicted* articulation map needs it just as much as
#: a v4 one); re-exported under this name because the negative-control battery in
#: ``validate_v4.py`` patches ``perf_chain_v4._index_at_after``.
_index_at_after = _pc_index_at_after


class _ScoreChain(PerfChain):
    """:class:`perf_chain.PerfChain` with the three v3-unreachable behaviours v4 exposes.

    **D0 -- an empty but PRESENT dynamicsMap leaves notes without a velocity at all.**
    ``DynamicsMap.renderDynamicsToMap(map)`` short-circuits on ``this.elements.isEmpty()``
    *before* writing anything (``DynamicsMap.java:392-394``), whereas the no-dynamicsMap
    overload writes ``velocity="100.0"`` explicitly (``:462-480``). ``PerfChain`` collapses
    both to 100.0 -- harmless in v3, where the two are never distinguished, but wrong for a
    part that shadows a global dynamicsMap with an empty local one. Here the empty map
    renders ``velocity = None`` ("the attribute does not exist"), and the articulation stage
    then skips its velocity modifier exactly as ``ArticulationData.articulateNote:209`` does
    (``if (velocityAtt != null)``) while still scaling ``duration.perf``.

    **D1 -- dynamics ``curvature``/``protraction`` are clamped at render time.**
    ``getDynamicsDataOf`` runs them through ``ensureCurvatureBoundaries`` /
    ``ensureProtractionBoundaries`` (``DynamicsMap.java:346, 350``);
    ``dynamics_math.inner_control_points`` does not, so the rows are clamped on the way in.

    **A6 -- an articulation whose date has no note is NOT skipped; it articulates the next
    note.** ``ArticulationMap.renderArticulationToMap_noMillisecondModifiers`` resolves a
    ``noteid``-less ``<articulation>`` through ``GenericMap.getAllElementsAt(date)``, which
    is ``getElementIndexAtAfter(date)`` -- *at or after* -- and then **adds that element
    unconditionally**, only key-checking the ones *after* it (``GenericMap.java``, and
    espressivo's identical ``GenericMap.ts``). Two consequences:

      * if a note exists exactly at the date, every note at that date is articulated (the
        chord case, CANONICAL.md A4) -- this is the only case v3 could produce, because its
        articulation dates were drawn from the single part's own note dates;
      * if none does, exactly **one** note is articulated, the first at or after the date,
        and the ``key == date`` guard immediately fails for its neighbours -- so a *chord*
        landed on this way gets the articulation on its first note only.

    v4 makes the second case routine: the sampler draws articulation dates from the **union**
    of both parts' onsets and installs the map globally, so every date that belongs only to
    the other part slides onto the next note of this one, and two such articulations can
    stack on the same note. Measured on ``ml/data/pilot_v4.jsonl`` (the 2026-08-09 11:28
    regeneration, 60 pieces / 7251 notes): **743 off-date landings, 282 stacked
    articulations, 22 articulations dropped past the last note**. ``PerfChain`` matches
    articulations by exact date -- correct for every v3 dataset and wrong here -- so the
    resolution is overridden rather than the map rewritten: the targets are note *indices*,
    which a date-keyed map cannot express.

    Assumes the MSM ``score`` holds only ``<note>`` elements (true for every generator in
    this program). meico skips non-note elements *after* selecting them, so a non-note at
    the selected index would consume the articulation entirely.
    """

    def __init__(self, tempo=None, dynamics=None, articulation=None, rubato=None,
                 dynamics_present=None):
        # D0: "present" must be decided BEFORE PerfChain's ``list(dynamics or [])`` collapses
        # None and [] onto each other. The caller passes it explicitly because by the time a
        # part's maps are resolved, `None` already means "inherited nothing".
        if dynamics_present is None:
            dynamics_present = dynamics is not None
        self.dynamics_present = bool(dynamics_present)
        self.no_velocity = self.dynamics_present and not dynamics
        dyn, n_clamped = _clamped_dynamics(dynamics or [])          # D1
        super().__init__(tempo=tempo, dynamics=dyn, articulation=articulation, rubato=rubato)
        self._dynamics_clamped = n_clamped

    def render(self, notes):
        out = super().render(notes)
        if self._dynamics_clamped:
            self.stats["dynamics_boundary_clamped"] = self._dynamics_clamped
        return out

    def _apply_dynamics(self, notes):
        if self.no_velocity:                    # D0: renderDynamicsToMap returned null early
            for n in notes:
                n.velocity = None
            return
        super()._apply_dynamics(notes)

    def _apply_articulation(self, notes):
        # The rule itself lives in PerfChain (v4 is not the only caller that needs it: a
        # *predicted* map's dates need not be onsets either). The override is kept rather
        # than expressed as `artic_targeting="at-or-after"` because validate_v4.py's
        # negative-control battery patches THIS attribute with the exact-date renderer, and
        # a chain that selected the rule by constructor argument would swallow the mutation.
        return self._apply_articulation_at_or_after(notes)
