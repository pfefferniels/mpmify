"""Exact Python port of meico's asynchronyMap rendering (constant per-part ms offsets).

Mirrors ``meico/mpm/elements/maps/AsynchronyMap.java`` line for line, cross-checked against
the espressivo TS port ``meico-ts/src/mpm/elements/maps/AsynchronyMap.ts`` (identical).

WHAT ASYNCHRONY IS.  ``<asynchrony date="..." milliseconds.offset="..."/>`` shifts every
millisecond timestamp of a map by a constant, from its date until the next asynchrony
instruction.  It is the only map that works purely in the millisecond domain, so
``Performance.perform`` runs it *after* the tempo map, on four maps per part: the pedalMap,
the channelVolumeMap, the positionMap and the score (``Performance.java:534-548``).

THE ONE THING THAT IS EASY TO GET WRONG: **segment membership is decided in the TICK
domain, and the note's end is taken from the *unmodified* ``duration`` attribute** --
``end = duration + key``, not ``date.end.perf`` and not ``duration.perf``.  Articulation's
``relativeDuration`` and rubato's warping both write ``duration.perf`` / ``date.end.perf``
and are invisible here.

Four consequences, all reproduced:

  A1  a note whose onset is in asynchrony segment *k* but whose **tick end** falls in
      segment *k+1* keeps its entry in the working list (``continue``), and its
      ``milliseconds.date.end`` is later shifted by segment *k+1*'s offset while its
      ``milliseconds.date`` keeps segment *k*'s.  A single note can therefore carry two
      different offsets.  (Verified against the Java fork: a note at tick 720 with duration
      720, asynchronies -30 @0 and +12.5 @1440, renders ms.date 570 = 600-30 and ms.date.end
      1212.5 = 1200+12.5.)
  A2  ``startDateMs`` is a *local* variable reset to 0.0 for every (instruction, entry)
      pair, and it is only assigned when the entry's key is at or after the instruction.
      In the A1 revisit the end-date floor is therefore ``0.0 + 1``, i.e. **1 ms**, not
      "the note's own start + 1".
  A3  the start clamp is ``Math.max(0.0, ms + offset)`` -- timings never go negative -- and
      the end clamp is ``Math.max(ms + offset, startDateMs + 1)`` -- a note is never shorter
      than 1 ms.  Both use Java's ``Math.max`` semantics (NaN-propagating,
      signed-zero-aware), which differ from Python's builtin; see :func:`java_max`.
  A4  an entry **without a ``duration`` attribute** (positionMap ``<position>``,
      channelVolumeMap ``<volume>``, timeSignature, ...) is finished after its start date is
      shifted -- it can never be revisited by a later asynchrony instruction.

Row format::

    [date_ticks, milliseconds_offset]

The map is applied through :meth:`AsynchronyTimeline.render`, which takes a list of
:class:`AsynchronyEntry` (key, tick duration or ``None``, and the two millisecond fields)
and mutates them in place, exactly as meico mutates XML attributes.
"""

import math

from java_libm import JAVA_DOUBLE_MAX

__all__ = ["ASY_DATE", "ASY_OFFSET", "ASY_ROW_LEN", "java_max",
           "AsynchronyEntry", "AsynchronyTimeline"]

ASY_DATE = 0
ASY_OFFSET = 1
ASY_ROW_LEN = 2


def java_max(a, b):
    """``java.lang.Math.max(double, double)``.

    Python's builtin ``max`` differs in two places that meico can actually reach:
    ``max(0.0, nan)`` returns ``0.0`` where Java returns ``NaN``, and ``max(-0.0, 0.0)``
    returns ``-0.0`` where Java returns ``+0.0``.  Both would show up as a
    non-bit-identical double in the validator, so the reference semantics are spelled out.
    """
    if a != a:                                          # a is NaN
        return a
    if a == 0.0 and b == 0.0 and math.copysign(1.0, a) < 0.0:
        return b                                        # -0.0 vs +0.0 -> the positive one
    return a if a >= b else b


class AsynchronyEntry:
    """A GenericMap entry as ``renderAsynchronyToMap`` sees it.

    ``key``       the element's map key = its **tick** ``date``
    ``duration``  the element's **tick** ``duration`` attribute, or ``None`` if it has none
    ``ms_date``   ``milliseconds.date``, or ``None`` if the element has no such attribute
    ``ms_end``    ``milliseconds.date.end``, or ``None``
    ``payload``   free slot for the caller (e.g. the NotePerf this entry stands for)
    """

    __slots__ = ("key", "duration", "ms_date", "ms_end", "payload")

    def __init__(self, key, duration=None, ms_date=None, ms_end=None, payload=None):
        self.key = float(key)
        self.duration = None if duration is None else float(duration)
        self.ms_date = ms_date
        self.ms_end = ms_end
        self.payload = payload

    def __repr__(self):
        return ("AsynchronyEntry(key=%r, duration=%r, ms_date=%r, ms_end=%r)"
                % (self.key, self.duration, self.ms_date, self.ms_end))


class AsynchronyTimeline:
    """An asynchronyMap: rows ``[date_ticks, milliseconds_offset]``, sorted by date."""

    def __init__(self, asynchrony_map):
        rows = []
        for r in (asynchrony_map or []):
            row = list(r)
            if len(row) != ASY_ROW_LEN:
                raise ValueError("asynchrony row must be [date, milliseconds_offset], got %r"
                                 % (r,))
            rows.append([float(row[ASY_DATE]), float(row[ASY_OFFSET])])
        for i in range(1, len(rows)):
            if rows[i][ASY_DATE] < rows[i - 1][ASY_DATE]:
                raise ValueError("asynchrony map is not sorted by date: row %d (date %s) "
                                 "precedes row %d (date %s)"
                                 % (i, rows[i][ASY_DATE], i - 1, rows[i - 1][ASY_DATE]))
        self.instrs = rows
        #: counters for the reference's order-dependent paths; see ``render``.
        self.stats = {}

    def __len__(self):
        return len(self.instrs)

    # -- AsynchronyMap.getAsynchronyAt(date)
    def offset_at(self, date):
        """The offset in force at ``date``. Not used by :meth:`render` (meico's renderer
        does not call it either); exposed for eval code."""
        i = -1
        for j in range(len(self.instrs)):
            if self.instrs[j][ASY_DATE] <= date:
                i = j
            else:
                break
        if i < 0:
            return 0.0
        return self.instrs[i][ASY_OFFSET]

    # -- AsynchronyMap.renderAsynchronyToMap(map)
    def render(self, entries):
        """Shift ``entries`` in place. ``entries`` must be in map order (= date order).

        Fills ``self.stats``:
          ``carried``   entries kept for a later instruction because their **tick** end
                        reached past the current segment (path A1) -- >0 means A1/A2 is
                        actually under test;
          ``start_shifted`` / ``end_shifted``  how many attributes were written;
          ``start_clamped`` / ``end_clamped``  how often A3's clamps bound.
        """
        self.stats = {"carried": 0, "start_shifted": 0, "end_shifted": 0,
                      "start_clamped": 0, "end_clamped": 0}
        if not self.instrs:
            return
        for i in range(1, len(entries)):
            if entries[i].key < entries[i - 1].key:
                raise ValueError("asynchrony target map is not sorted by date: entry %d "
                                 "(date %s) precedes entry %d (date %s)"
                                 % (i, entries[i].key, i - 1, entries[i - 1].key))

        map_entries = list(entries)
        done = []
        n_instr = len(self.instrs)

        for asyn_index in range(n_instr):
            asyn_date = self.instrs[asyn_index][ASY_DATE]
            asyn_end_date = (self.instrs[asyn_index + 1][ASY_DATE]
                             if asyn_index < (n_instr - 1) else JAVA_DOUBLE_MAX)
            offset = self.instrs[asyn_index][ASY_OFFSET]

            for entry in map_entries:
                if entry.key >= asyn_end_date:
                    break

                start_date_ms = 0.0                                     # A2: per-pair local
                if entry.key >= asyn_date:
                    if entry.ms_date is not None:
                        raw = entry.ms_date + offset
                        start_date_ms = java_max(0.0, raw)              # A3
                        if start_date_ms != raw:
                            self.stats["start_clamped"] += 1
                        entry.ms_date = start_date_ms
                        self.stats["start_shifted"] += 1

                if entry.duration is None:                              # A4
                    done.append(entry)
                    continue

                end = entry.duration + entry.key                        # TICK domain
                if end >= asyn_end_date:
                    self.stats["carried"] += 1                          # A1
                    continue

                if end >= asyn_date:
                    if entry.ms_end is not None:
                        ms = entry.ms_end + offset
                        clamped = java_max(ms, start_date_ms + 1)       # A3
                        if clamped != ms:
                            self.stats["end_clamped"] += 1
                        entry.ms_end = clamped
                        self.stats["end_shifted"] += 1

                done.append(entry)

            # meico removes the finished entries only after the inner loop (splicing during
            # it would skip entries); ArrayList.remove(Object) drops the FIRST equal element,
            # which for distinct objects is identity removal.
            for remove_me in done:
                map_entries.remove(remove_me)
            done.clear()
