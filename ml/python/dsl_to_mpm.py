"""Model output -> real MPM.

`maps_to_mpm()` turns the map representation the model works in (the same rows the
generator writes into the JSONL and `dsl.decode_piece()` returns) into a complete MPM
document string that meico's own parser accepts.

Row formats (exactly as in the JSONL / dsl.py):
    tempo_map: [date_ticks, bpm, transition_to | None, meanTempoAt | None]
    dyn_map:   [date_ticks, volume, transition_to | None, curvature | None, protraction | None]

The emitted XML reproduces meico's own serialization byte for byte for canonical-form
maps (verified against generator-written .mpm files in validate_export.py), i.e.:

    <?xml version="1.0"?>
    <mpm xmlns="http://www.cemfi.de/mpm/ns/1.0"><performance name="..." pulsesPerQuarter="720">
      <global><header /><dated>
        <tempoMap><tempo date="0.0" bpm="97.9" beatLength="0.25" />
                  <tempo date="6480.0" bpm="161.2" transition.to="125.5" beatLength="0.25" meanTempoAt="0.65" /></tempoMap>
        <dynamicsMap><dynamics date="0.0" volume="100.8" />
                     <dynamics date="9360.0" volume="100.8" transition.to="88.6" curvature="0.15" protraction="-0.68" /></dynamicsMap>
      </dated></global>
      <part name="Piano" number="1" midi.channel="0" midi.port="0"><header /><dated /></part>
    </performance></mpm>

CANONICALIZATION (`canonicalize_maps`, applied by `maps_to_mpm` before emitting).
Model output is unconstrained, meico normalizes silently on parse, and the Python
render-space oracles (`tempo_math`, `dynamics_math`) do neither.  So every parse-time
normalization meico performs is applied HERE, to the rows, before they are written --
that way the emitted XML, meico's internal object graph and the Python oracle fed with
the canonicalized rows all mean the same thing.  Evaluators that render a model map in
Python MUST call `canonicalize_maps()` on it first, or they measure something meico
would never produce.

  * SORTING: meico sorts every map on parse (`GenericMap` ctor, stable insertion sort,
    `sortXml()` at GenericMap.java:123), so an out-of-order row set renders in date
    order no matter how it is written.  We sort the rows (Python's stable sort matches
    meico's stable insertion order for equal dates).  Unsorted export was a silent
    divergence: meico rendered the sorted map, the Python oracle read the rows as given.
  * curvature is CLAMPED to [0, 1] and protraction to [-1, 1] -- meico clamps on parse
    (`ensureCurvatureBoundaries` / `ensureProtractionBoundaries`, DynamicsMap.java:249
    and :266) and only warns on stderr.  Emitting the raw value diverged from the
    Python oracle by up to 46.6 velocity units.
  * meanTempoAt <= 0 collapses the instruction to a CONSTANT at the target value,
    meanTempoAt >= 1 to a constant at the start value (TempoMap.java:250-257).  Rows are
    rewritten accordingly (`tempo_math` would otherwise raise or diverge).
  * An EMPTY tempo map is rejected (`allow_no_tempo=True` to override): meico renders
    such a file happily at its default tempo and writes plausible-looking
    milliseconds.* attributes that mean nothing the model asked for.
  * NaN / infinity, negative dates, bpm <= 0 and a first tempo instruction after date 0
    are rejected (`MpmExportError`).

What meico's parser actually requires (probed empirically, see validate_export.py and
scratchpad probe_parser.py):

  * `beatLength` is MANDATORY on every `tempo`. TempoMap.getTempoDataOf() returns null
    for a tempo element without it, so the instruction is dropped SILENTLY -- meico
    exits 0 and the augmented MSM simply carries no `milliseconds.*` attributes at all.
    This is the one omission that fails without an error message, hence beatLength is
    emitted unconditionally here.
  * The namespace is IGNORED. meico resolves everything through
    `Helper.getFirstChildElement` / `getAllChildElements`, which match on
    `getLocalName()` / XPath `local-name()`. A missing xmlns, a wrong xmlns and a
    fully prefixed document all render bit-identically. We still emit the official
    namespace so the files validate against the MPM schema and open in other tools.
  * Attribute order and the XML declaration are irrelevant; the `<part>` element is
    optional as long as every instruction lives in `<global>`.
  * `performance/@pulsesPerQuarter` is NOT cosmetic: it is the tick scale the dates are
    read in, so it must equal the MSM's ppq (720 here) or the whole timeline stretches.
  * `meanTempoAt` omitted == `meanTempoAt="0.5"` (default exponent 1.0, linear).
"""

import math
from decimal import Decimal, ROUND_HALF_UP

MPM_NAMESPACE = "http://www.cemfi.de/mpm/ns/1.0"
DEFAULT_BEAT_LENGTH = 0.25
CURVATURE_RANGE = (0.0, 1.0)        # DynamicsMap.ensureCurvatureBoundaries
PROTRACTION_RANGE = (-1.0, 1.0)     # DynamicsMap.ensureProtractionBoundaries


class MpmExportError(ValueError):
    """A map row meico cannot render as the caller intends (or not at all)."""


# ---------------------------------------------------------------- number formatting

def _jd(v):
    """Java `Double.toString(double)`.

    Reproduces Java's *format*: "NaN" / "Infinity" / "-Infinity", a signed zero as
    "0.0"/"-0.0", plain decimal notation with at least one digit on each side of the
    point for 1e-3 <= |v| < 1e7, and computerized scientific notation
    (`d.dddE[-]exp`, no '+', no leading exponent zeros) outside that range.

    Digits come from Python's repr, i.e. the shortest decimal that round-trips.  That is
    what `Double.toString` is specified to produce and what JDK >= 19 does produce;
    JDK 17 (the JDK this project renders with) occasionally prints one digit more than
    necessary, so a handful of extreme values differ in spelling from this JDK's output.
    Every such case still parses back to the identical double, so the XML always MEANS
    the number that was passed in -- only the byte-identity property with meico's own
    serializer is limited to the value domain this project uses (measured: 0 mismatches
    over 125k in-range values, see validate_export.py --formats).
    """
    v = float(v)
    if v != v:
        return "NaN"
    if v == math.inf:
        return "Infinity"
    if v == -math.inf:
        return "-Infinity"
    sign = "-" if math.copysign(1.0, v) < 0.0 else ""
    a = abs(v)
    if a == 0.0:
        return sign + "0.0"
    # shortest round-trip digits + scientific exponent: a == d[0].d[1:] * 10**e
    digits, exp = Decimal(repr(a)).normalize().as_tuple()[1:]
    ds = "".join(map(str, digits))
    e = len(ds) - 1 + exp
    if -3 <= e < 7:                                  # Java's plain-notation window
        if e >= 0:
            ip = ds[:e + 1].ljust(e + 1, "0")
            fp = ds[e + 1:] or "0"
        else:
            ip, fp = "0", "0" * (-e - 1) + ds
        return f"{sign}{ip}.{fp}"
    return f"{sign}{ds[0]}.{ds[1:] or '0'}E{e}"


def _num(v):
    """Mirror of `SampleAndRender.fmt()`: `String.format("%.2f", v)` with trailing zeros
    (and a trailing dot) stripped. Java's %.2f rounds HALF_UP on the exact binary value,
    which `Decimal(float).quantize(..., ROUND_HALF_UP)` reproduces exactly.

    Canonical-form values (<= 2 decimals) therefore serialize byte-identically to meico's
    own output. A value that would LOSE precision under %.2f -- a model may emit more
    digits than the sampler ever does -- falls back to the full round-trip repr, so the
    XML always means exactly the number that was passed in."""
    v = float(v)
    if v != v or math.isinf(v):
        return _jd(v)
    s = str(Decimal(v).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
    while s.endswith("0"):
        s = s[:-1]
    if s.endswith("."):
        s = s[:-1]
    return s if float(s) == v else _jd(v)


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _row(row, n):
    """Pad/truncate a map row to n fields, missing ones become None."""
    row = list(row)
    return (row + [None] * n)[:n]


# ---------------------------------------------------------------- canonicalization

def _f(value, field, index, positive=False, non_negative=False):
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise MpmExportError(f"row {index}: {field} is not a number: {value!r}")
    if v != v or math.isinf(v):
        raise MpmExportError(f"row {index}: {field} must be finite, got {v}")
    if positive and v <= 0.0:
        raise MpmExportError(f"row {index}: {field} must be > 0, got {v}")
    if non_negative and v < 0.0:
        raise MpmExportError(f"row {index}: {field} must be >= 0, got {v}")
    return v


def _clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def canonicalize_tempo_map(tempo_map, require_start_at_zero=True):
    """Sort + normalize tempo rows the way meico's parser will (see module docstring).

    Returns a new list of 4-field rows; raises MpmExportError on input meico cannot
    render as intended (non-finite values, negative dates, bpm <= 0, no instruction at
    date 0)."""
    rows = []
    for i, raw in enumerate(tempo_map or []):
        date, bpm, to, mta = _row(raw, 4)
        date = _f(date, "date", i, non_negative=True)
        bpm = _f(bpm, "bpm", i, positive=True)
        if to is not None:
            to = _f(to, "transition.to", i, positive=True)
        if to is None:
            mta = None                                   # meaningless without a target
        elif to != bpm and mta is not None:
            mta = _f(mta, "meanTempoAt", i)
            if mta <= 0.0:                               # TempoMap.java:250-254
                bpm, to, mta = to, None, None            # constant at the TARGET value
            elif mta >= 1.0:                             # TempoMap.java:255-257
                to, mta = None, None                     # constant at the START value
        rows.append([date, bpm, to, mta])
    rows.sort(key=lambda r: r[0])                        # stable, like meico's parse sort
    if rows and require_start_at_zero and rows[0][0] != 0.0:
        raise MpmExportError(
            f"first tempo instruction is at date {rows[0][0]}, not 0: notes before it "
            "have no tempo instruction in meico and no defined position in tempo_math")
    return rows


def canonicalize_dynamics_map(dyn_map):
    """Sort + normalize dynamics rows the way meico's parser will: curvature clamped to
    [0,1], protraction to [-1,1] (meico clamps silently, warning only on stderr)."""
    rows = []
    for i, raw in enumerate(dyn_map or []):
        date, vol, to, curv, prot = _row(raw, 5)
        date = _f(date, "date", i, non_negative=True)
        vol = _f(vol, "volume", i)
        if to is not None:
            to = _f(to, "transition.to", i)
        if to is None:
            curv = prot = None                           # meaningless without a target
        else:
            if curv is not None:
                curv = _clamp(_f(curv, "curvature", i), *CURVATURE_RANGE)
            if prot is not None:
                prot = _clamp(_f(prot, "protraction", i), *PROTRACTION_RANGE)
        rows.append([date, vol, to, curv, prot])
    rows.sort(key=lambda r: r[0])
    return rows


def canonicalize_maps(tempo_map, dyn_map=None, require_start_at_zero=True):
    """Both maps at once -- the rows the exported MPM will contain, and therefore the
    rows a Python render-space evaluator must use to stay in sync with meico."""
    return (canonicalize_tempo_map(tempo_map, require_start_at_zero),
            canonicalize_dynamics_map(dyn_map))


# ---------------------------------------------------------------- MPM assembly

def _tempo_element(row, beat_length):
    date, bpm, to, mta = _row(row, 4)
    attrs = [("date", _jd(date)), ("bpm", _num(bpm))]
    if to is not None:
        attrs.append(("transition.to", _num(to)))
    attrs.append(("beatLength", _jd(beat_length)))
    if to is not None and mta is not None:
        attrs.append(("meanTempoAt", _jd(mta)))
    return "<tempo " + " ".join(f'{k}="{_esc(v)}"' for k, v in attrs) + " />"


def _dynamics_element(row):
    date, vol, to, curv, prot = _row(row, 5)
    attrs = [("date", _jd(date)), ("volume", _num(vol))]
    if to is not None:
        attrs.append(("transition.to", _num(to)))
        if curv is not None:
            attrs.append(("curvature", _jd(curv)))
        if prot is not None:
            attrs.append(("protraction", _jd(prot)))
    return "<dynamics " + " ".join(f'{k}="{_esc(v)}"' for k, v in attrs) + " />"


def maps_to_mpm(tempo_map, dyn_map=None, ppq=720, name="generated",
                beat_length=DEFAULT_BEAT_LENGTH, parts=(("Piano", 1, 0, 0),),
                allow_no_tempo=False):
    """Build a complete MPM document (as a string) from model-space maps.

    tempo_map: iterable of [date_ticks, bpm, transition_to|None, meanTempoAt|None]
    dyn_map:   iterable of [date_ticks, volume, to|None, curvature|None, protraction|None]
    ppq:       performance/@pulsesPerQuarter (must match the MSM's pulsesPerQuarter)
    name:      performance/@name
    parts:     (name, number, midi.channel, midi.port) tuples; MPM parts carry no maps
               here, all instructions are global.
    allow_no_tempo: permit an empty tempo map. OFF by default -- without a tempoMap
               meico renders at its own default tempo and still writes milliseconds.*,
               so the output looks fine and means nothing.

    Rows are canonicalized first (sorted, clamped, meico's parse-time collapses applied);
    see `canonicalize_maps`. Raises MpmExportError for input meico cannot render as
    intended."""
    tempo_map, dyn_map = canonicalize_maps(tempo_map, dyn_map)
    if not tempo_map and not allow_no_tempo:
        raise MpmExportError(
            "empty tempo map: meico would render this file at its default tempo and "
            "still emit milliseconds.* attributes (silently meaningless). "
            "Pass allow_no_tempo=True if that is really what you want.")
    beat_length = _f(beat_length, "beatLength", -1, positive=True)
    ppq = int(ppq)
    if ppq <= 0:
        raise MpmExportError(f"pulsesPerQuarter must be > 0, got {ppq}")

    maps = []
    if tempo_map:
        maps.append("<tempoMap>"
                    + "".join(_tempo_element(r, beat_length) for r in tempo_map)
                    + "</tempoMap>")
    if dyn_map:
        maps.append("<dynamicsMap>"
                    + "".join(_dynamics_element(r) for r in dyn_map)
                    + "</dynamicsMap>")

    part_xml = "".join(
        f'<part name="{_esc(pn)}" number="{int(num)}" midi.channel="{int(ch)}"'
        f' midi.port="{int(port)}"><header /><dated /></part>'
        for pn, num, ch, port in parts)

    return ('<?xml version="1.0"?>\n'
            f'<mpm xmlns="{MPM_NAMESPACE}">'
            f'<performance name="{_esc(name)}" pulsesPerQuarter="{int(ppq)}">'
            '<global><header /><dated>' + "".join(maps) + '</dated></global>'
            + part_xml +
            '</performance></mpm>\n')


# ---------------------------------------------------------------- CLI

if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) < 4:
        print("Usage: dsl_to_mpm.py <pieces.jsonl> <index> <out.mpm>", file=sys.stderr)
        sys.exit(1)
    with open(sys.argv[1]) as fh:
        for i, line in enumerate(fh):
            if i == int(sys.argv[2]):
                rec = json.loads(line)
                break
        else:
            print("index out of range", file=sys.stderr)
            sys.exit(1)
    xml = maps_to_mpm(rec.get("tempo", []), rec.get("dynamics", []),
                      ppq=rec.get("ppq", 720), name="perf")
    with open(sys.argv[3], "w") as fh:
        fh.write(xml)
    print(f"wrote {sys.argv[3]}")
