#!/usr/bin/env python3
"""fenby demo-artifact generator: checkpoint + record id -> one self-contained HTML page.

    python3 generate_demo.py --ckpt ../runs/v41-asyn-h100/ckpt.pt \
        --data ../data/vienna_infer_windows.jsonl --id Schubert_D783_no15_p01_w1 \
        --out demo-1-schubert.html
    python3 generate_demo.py --preds preds.json --id 7 --out demo-2-synthetic.html
    python3 generate_demo.py --selftest          # XML emitter vs the generator's own .mpm

What the page contains (SYSTEM.md 2.4): the input performance, the emitted MPM as readable
per-map instruction tables *and* as compiled MPM XML, an inline-SVG overlay of performed vs
re-rendered vs baseline onsets, per-map sparklines, and a caveats footer filled from the
record's own metrics.

**The page is a rendering of the preds JSON and of nothing else.**  Every number on it is
either copied from a key of that file or computed from one of its map rows by this
program's own exact math (`tempo_math`, `dynamics_math`, `rubato_math`) -- the same
functions the evaluator and the renderer use.  The generator never re-runs the model, never
re-renders, and never estimates: if a quantity is not in the JSON and not derivable from it
by those functions, it does not go on the page.  §Provenance at the foot of every page
prints the key each figure came from.  The JSON is produced by `infer_v4.py --dump-maps`,
which refuses to write a dump whose re-rendered series do not reproduce the evaluator's
RMSEs bit for bit, so "traceable to the preds JSON" and "traceable to the evaluated
prediction" are the same statement.

The MPM writer is a port of `ml/node/xml.mjs::buildMpm` -- the generator's own writer, the
one whose documents both renderers parse -- extended over the maps `dsl_to_mpm.py` does not
cover (rubato, part-local articulation, asynchrony, movement).  It is not trusted because
it looks right: `--selftest` rebuilds the MPM of all 100 `pilot_v4.jsonl` records from
their JSONL maps and compares byte for byte against the `.mpm` files the Node generator
wrote for those same records (`ml/data/debug_v4/piece*.mpm`).  Number formatting is
imported from `dsl_to_mpm` (`_jd` = Java `Double.toString`, `_num` = `%.2f` stripped)
rather than re-spelled.

Scope of the emitted document: the model predicts tempo, dynamics, rubato and asynchrony
through the DSL decoder and articulation through the per-note heads, so those five maps are
what the XML contains.  There is no `movementMap`: pedal is predicted per note as a state,
and the reconstruction pass that turns states back into movement instructions is v1.1
(SYSTEM.md §4).  The page says so rather than leaving the omission to be noticed.
"""

import argparse
import html
import json
import math
import re
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "python"))

from dsl_to_mpm import _jd, _num  # noqa: E402, PLC2701 -- the project's number formatters
import dynamics_math  # noqa: E402
import rubato_math  # noqa: E402
import tempo_math  # noqa: E402

PPQ = 720
#: `ml/node/sampler.mjs` MovementData defaults; an attribute equal to them is not written.
MOVEMENT_DEFAULT_CURVATURE = 0.4
MOVEMENT_DEFAULT_PROTRACTION = 0.0
#: `ml/node/generate_v4.mjs:354-356` -- the part stubs every v4 document has.
PART_STUBS = {1: ("Piano", 0, 0), 2: ("Bass", 1, 0)}
MAP_ORDER = ("tempo", "dynamics", "rubato", "articulation", "movement", "asynchrony")
NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


# --------------------------------------------------------------------------- MPM emitter

def _bool_xml(v):
    return "true" if v else "false"


def _tempo_xml(rows):
    out = []
    for row in rows:
        date_, bpm, to, mta = (list(row) + [None] * 4)[:4]
        if to is None:
            out.append(f'<tempo date="{_jd(date_)}" bpm="{_num(bpm)}" beatLength="0.25" />')
        else:
            out.append(f'<tempo date="{_jd(date_)}" bpm="{_num(bpm)}" '
                       f'transition.to="{_num(to)}" beatLength="0.25" '
                       f'meanTempoAt="{_jd(mta)}" />')
    return "<tempoMap>" + "".join(out) + "</tempoMap>"


def _dynamics_xml(rows):
    out = []
    for row in rows:
        date_, vol, to, curv, prot = (list(row) + [None] * 5)[:5]
        if to is None:
            out.append(f'<dynamics date="{_jd(date_)}" volume="{_num(vol)}" />')
        else:
            out.append(f'<dynamics date="{_jd(date_)}" volume="{_num(vol)}" '
                       f'transition.to="{_num(to)}" curvature="{_jd(curv)}" '
                       f'protraction="{_jd(prot)}" />')
    return "<dynamicsMap>" + "".join(out) + "</dynamicsMap>"


def _articulation_xml(rows):
    out = [f'<articulation date="{_jd(r[0])}" relativeDuration="{_jd(r[1])}" '
           f'absoluteVelocityChange="{_jd(r[2])}" />' for r in rows]
    return "<articulationMap>" + "".join(out) + "</articulationMap>"


def _rubato_xml(rows):
    out = []
    for row in rows:
        date_, frame, intensity, late, early, loop = (list(row) + [None] * 6)[:6]
        out.append(f'<rubato date="{_jd(date_)}" frameLength="{_jd(frame)}" '
                   f'intensity="{_jd(intensity)}" lateStart="{_jd(late)}" '
                   f'earlyEnd="{_jd(early)}" loop="{_bool_xml(loop)}" />')
    return "<rubatoMap>" + "".join(out) + "</rubatoMap>"


def _movement_xml(rows):
    out = []
    for row in rows:
        row = list(row) + [None] * 6
        date_, position, to, curv, prot, controller = row[:6]
        e = f'<movement date="{_jd(date_)}" position="{_jd(position)}"'
        if to is not None:
            e += f' transition.to="{_jd(to)}"'
        if curv is not None and curv != MOVEMENT_DEFAULT_CURVATURE:
            e += f' curvature="{_jd(curv)}"'
        if prot is not None and prot != MOVEMENT_DEFAULT_PROTRACTION:
            e += f' protraction="{_jd(prot)}"'
        out.append(f'{e} controller="{controller or "sustain"}" />')
    return "<movementMap>" + "".join(out) + "</movementMap>"


def _asynchrony_xml(rows):
    out = [f'<asynchrony date="{_jd(r[0])}" milliseconds.offset="{_jd(r[1])}" />'
           for r in rows]
    return "<asynchronyMap>" + "".join(out) + "</asynchronyMap>"


def split_articulation(rows):
    """``articulation`` rows -> ``(global_rows, {part: rows})`` (CANONICAL A6).

    4-wide rows carry their part and belong inside that ``<part>``; 3-wide rows are the
    pre-A6 (v3-compat) shape and stay global, which is what makes those documents
    byte-comparable with the Java sampler's.
    """
    rows = list(rows or [])
    if not rows:
        return [], {}
    widths = {len(r) for r in rows}
    if widths == {3}:
        return rows, {}
    if widths != {4}:
        raise ValueError(f"articulation rows mix widths {sorted(widths)}")
    per_part = {}
    for date_, rel_dur, vel_change, part in rows:
        per_part.setdefault(part, []).append([date_, rel_dur, vel_change])
    return [], per_part


def maps_to_mpm_full(maps, notes=None, ppq=PPQ, name="perf"):
    """Full-map MPM document, mirroring `ml/node/xml.mjs::buildMpm`.

    `maps` are the program's own map rows (JSONL / `dsl.decode_piece_v4` shapes).  Parts
    come from `notes` when given (part numbers in field 6), else from the maps that are
    part-scoped; the asynchronyMap always goes on part 2 (CANONICAL Y1).
    """
    global_artic, part_artic = split_articulation(maps.get("articulation"))
    numbers = set()
    for n in notes or []:
        numbers.add(n[6] if len(n) > 6 else 1)
    numbers |= set(part_artic)
    if maps.get("asynchrony"):
        numbers.add(2)
    numbers = sorted(numbers) or [1]

    out = ['<?xml version="1.0"?>\n<mpm xmlns="http://www.cemfi.de/mpm/ns/1.0">',
           f'<performance name="{name}" pulsesPerQuarter="{int(ppq)}">',
           "<global><header /><dated>"]
    if maps.get("tempo"):
        out.append(_tempo_xml(maps["tempo"]))
    if maps.get("dynamics"):
        out.append(_dynamics_xml(maps["dynamics"]))
    if global_artic:
        out.append(_articulation_xml(global_artic))
    if maps.get("rubato"):
        out.append(_rubato_xml(maps["rubato"]))
    if maps.get("movement"):
        out.append(_movement_xml(maps["movement"]))
    out.append("</dated></global>")
    for number in numbers:
        pname, channel, port = PART_STUBS.get(number, (f"Part{number}", number - 1, 0))
        out.append(f'<part name="{pname}" number="{number}" midi.channel="{channel}"'
                   f' midi.port="{port}"><header /><dated>')
        if number == 2 and maps.get("asynchrony"):
            out.append(_asynchrony_xml(maps["asynchrony"]))
        if part_artic.get(number):
            out.append(_articulation_xml(part_artic[number]))
        out.append("</dated></part>")
    out.append("</performance></mpm>")
    return "".join(out)


def selftest(pilot=None, debug_dir=None, limit=100):
    """Rebuild every pilot record's MPM and diff it against the Node generator's own file."""
    pilot = Path(pilot or HERE.parent / "data" / "pilot_v4.jsonl")
    debug_dir = Path(debug_dir or HERE.parent / "data" / "debug_v4")
    ok = bad = 0
    with open(pilot) as fh:
        for i, line in enumerate(fh):
            if i >= limit:
                break
            ref_path = debug_dir / f"piece{i}.mpm"
            if not ref_path.exists():
                continue
            rec = json.loads(line)
            got = maps_to_mpm_full({k: rec.get(k) or [] for k in MAP_ORDER},
                                   notes=rec["notes"], ppq=rec.get("ppq", PPQ))
            ref = ref_path.read_text()
            if got == ref:
                ok += 1
            else:
                bad += 1
                j = next((k for k in range(min(len(got), len(ref))) if got[k] != ref[k]),
                         min(len(got), len(ref)))
                print(f"piece{i}: MISMATCH at char {j}\n  got {got[j:j + 90]!r}\n"
                      f"  ref {ref[j:j + 90]!r}")
    print(f"XML self-test: {ok} byte-exact, {bad} mismatching "
          f"(reference: {debug_dir}/piece*.mpm written by ml/node/xml.mjs)")
    return bad == 0


# --------------------------------------------------------------------------- small utils

def esc(s):
    return html.escape(str(s), quote=False)


def fnum(v, nd=2):
    if v is None:
        return "—"
    if isinstance(v, float) and v != v:
        return "NaN"
    if isinstance(v, (int, float)):
        return f"{v:.{nd}f}"
    return esc(v)


def indent_xml(xml):
    """One element per line, nesting indented. Characters are otherwise untouched: the
    writer emits a single line, and the page says so."""
    out, depth = [], 0
    for tok in xml.replace("><", ">\x00<").split("\x00"):
        if tok.startswith("</"):
            depth -= 1
        out.append("  " * max(depth, 0) + tok)
        if not tok.startswith("</") and not tok.endswith("/>") and tok.startswith("<") \
                and not tok.startswith("<?"):
            depth += 1
    return "\n".join(out)


def beats(ticks, ppq=PPQ):
    return ticks / ppq


def pitch_name(p):
    return f"{NOTE_NAMES[int(p) % 12]}{int(p) // 12 - 1}"


def table(headers, rows, right=(), cls=""):
    """headers: list of str; rows: list of list of already-escaped-or-numeric cells."""
    th = "".join(f'<th class="{"num" if i in right else ""}">{esc(h)}</th>'
                 for i, h in enumerate(headers))
    body = []
    for row in rows:
        cells = "".join(f'<td class="{"num" if i in right else ""}">{c}</td>'
                        for i, c in enumerate(row))
        body.append(f"<tr>{cells}</tr>")
    return (f'<div class="tablewrap"><table class="{cls}"><tr>{th}</tr>'
            + "".join(body) + "</table></div>")


# --------------------------------------------------------------------------- svg charts

COLOR = {"ink": "var(--ink)", "accent": "var(--accent)", "muted": "var(--muted)"}


def _nice_ticks(lo, hi, n=4):
    if not (hi > lo):
        hi = lo + max(abs(lo) * 0.1, 1.0)
    raw = (hi - lo) / max(n, 1)
    mag = 10.0 ** math.floor(math.log10(raw)) if raw > 0 else 1.0
    step = next((m * mag for m in (1, 2, 2.5, 5, 10) if raw <= m * mag), 10 * mag)
    first = math.ceil(lo / step) * step
    ticks, v = [], first
    while v <= hi + step * 1e-9:
        ticks.append(0.0 if abs(v) < step * 1e-9 else v)
        v += step
    return ticks


def _fmt_tick(v):
    if abs(v) >= 100 or float(v).is_integer():
        return f"{v:.0f}"
    return f"{v:.2f}".rstrip("0").rstrip(".")


def line_chart(series, *, width=760, height=300, x_label="", y_label="", zero_line=False,
               y_ticks=4, x_ticks=5, label_ends=True, pad_right=78, font=10):
    """Multi-series line chart as inline SVG (no script, no external anything).

    `series`: dicts with `name`, `points` [(x, y)], `color` (ink/accent/muted), optional
    `dash`, `width`, `tip`.  Identity is carried by color AND dash AND a direct end label:
    the page's palette is the program's editorial one (ink / crimson / gray), whose
    gray-crimson pair sits in the 6-8 CVD band where the dataviz rule requires a second
    encoding channel.
    """
    series = [s for s in series if s.get("points")]
    if not series:
        return '<p class="caption">no data</p>'
    xs = [p[0] for s in series for p in s["points"]]
    ys = [p[1] for s in series for p in s["points"]]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    if zero_line:
        y0, y1 = min(y0, 0.0), max(y1, 0.0)
    if y1 - y0 < 1e-9:
        y0, y1 = y0 - 1, y1 + 1
    span = y1 - y0
    y0, y1 = y0 - span * 0.08, y1 + span * 0.08
    # The x-axis label gets its own row under the ticks: sharing the row put "score
    # position (beats)" on top of the last tick at every width the page is read at.
    pl, pr, pt, pb = 52, pad_right, 16, (44 if x_label else 26)

    def sx(x):
        return pl + (x - x0) / (x1 - x0 or 1) * (width - pl - pr)

    def sy(y):
        return pt + (y1 - y) / (y1 - y0 or 1) * (height - pt - pb)

    out = [f'<svg viewBox="0 0 {width} {height}" role="img" '
           f'aria-label="{esc(y_label)} against {esc(x_label)}" '
           f'xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">']
    for t in _nice_ticks(y0 + span * 0.08, y1 - span * 0.08, y_ticks):
        y = sy(t)
        out.append(f'<line x1="{pl}" y1="{y:.1f}" x2="{width - pr}" y2="{y:.1f}" '
                   f'stroke="var(--border)" stroke-width="1" />')
        out.append(f'<text x="{pl - 6}" y="{y + 3:.1f}" text-anchor="end" '
                   f'font-size="{font}" fill="var(--muted)">{_fmt_tick(t)}</text>')
    if zero_line and y0 < 0 < y1:
        out.append(f'<line x1="{pl}" y1="{sy(0):.1f}" x2="{width - pr}" y2="{sy(0):.1f}" '
                   f'stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 3" />')
    tick_y = height - pb + 16
    for t in _nice_ticks(x0, x1, x_ticks):
        if not (x0 - 1e-9 <= t <= x1 + 1e-9):
            continue
        out.append(f'<text x="{sx(t):.1f}" y="{tick_y}" text-anchor="middle" '
                   f'font-size="{font}" fill="var(--muted)">{_fmt_tick(t)}</text>')
    if y_label:
        out.append(f'<text x="0" y="{pt - 4}" font-size="{font}" fill="var(--muted)">'
                   f'{esc(y_label)}</text>')
    if x_label:
        out.append(f'<text x="{(pl + width - pr) / 2:.1f}" y="{height - 5}" '
                   f'text-anchor="middle" font-size="{font}" fill="var(--muted)">'
                   f'{esc(x_label)}</text>')
    ends = []
    for s in series:
        pts = " ".join(f"{sx(x):.1f},{sy(y):.1f}" for x, y in s["points"])
        dash = f' stroke-dasharray="{s["dash"]}"' if s.get("dash") else ""
        out.append(f'<polyline points="{pts}" fill="none" stroke="{COLOR[s["color"]]}" '
                   f'stroke-width="{s.get("width", 1.6)}" stroke-linejoin="round" '
                   f'stroke-linecap="round"{dash}><title>{esc(s.get("tip") or s["name"])}'
                   f'</title></polyline>')
        lx, ly = s["points"][-1]
        ends.append((sy(ly), s))
    if label_ends:
        placed = []
        for y, s in sorted(ends, key=lambda e: e[0]):
            while any(abs(y - p) < 11 for p in placed):
                y += 11
            placed.append(y)
            out.append(f'<text x="{width - pr + 6}" y="{y + 3:.1f}" font-size="{font}" '
                       f'fill="{COLOR[s["color"]]}">{esc(s["name"])}</text>')
    out.append("</svg>")
    return "".join(out)


def legend(series):
    parts = []
    for s in series:
        dash = f' stroke-dasharray="{s["dash"]}"' if s.get("dash") else ""
        parts.append(
            f'<span><svg width="24" height="8" aria-hidden="true">'
            f'<line x1="1" y1="4" x2="23" y2="4" stroke="{COLOR[s["color"]]}" '
            f'stroke-width="{s.get("width", 1.6)}"{dash} /></svg>{esc(s["name"])}</span>')
    return '<div class="legend">' + "".join(parts) + "</div>"


def chart_block(series, *, caption="", **kw):
    return ('<div class="chart">' + legend(series) + line_chart(series, **kw)
            + (f'<p class="caption">{caption}</p>' if caption else "") + "</div>")


def spark(title, series, caption="", **kw):
    kw.setdefault("width", 380)
    kw.setdefault("height", 150)
    kw.setdefault("pad_right", 14)
    kw.setdefault("label_ends", False)
    kw.setdefault("y_ticks", 3)
    kw.setdefault("x_ticks", 4)
    body = line_chart(series, **kw) if series else '<p class="caption">— none emitted —</p>'
    return (f'<div class="spark"><h3>{esc(title)}</h3>{legend(series) if series else ""}'
            f'{body}<p class="caption">{caption}</p></div>')


# ----------------------------------------------------------------- curves from map rows

def _ends(rows, total_ticks):
    """End date of every instruction: the next one's date, the piece end for the last."""
    return [(rows[i + 1][0] if i + 1 < len(rows) else max(total_ticks, rows[i][0] + 1))
            for i in range(len(rows))]


def _grid(total_ticks, min_step, max_points=800):
    """Sampling step: fine enough for the shortest legal segment (4 beats = 2880 ticks),
    coarse enough that a 64-beat piece does not put 3000 points into every polyline."""
    return max(min_step, math.ceil(max(total_ticks, 1) / max_points))


def tempo_curve(rows, total_ticks, step=None):
    """bpm sampled on a tick grid through `tempo_math.tempo_at` -- meico's own formula."""
    if not rows:
        return []
    step = step or _grid(total_ticks, 45)
    ends = _ends(rows, total_ticks)
    pts = []
    t = rows[0][0]
    while t <= total_ticks:
        i = max(j for j in range(len(rows)) if rows[j][0] <= t)
        pts.append((beats(t), tempo_math.tempo_at(t, rows[i], ends[i])))
        t += step
    return pts


def dynamics_curve(rows, total_ticks, step=None):
    """volume sampled through `dynamics_math.dynamics_at` -- meico's Bezier, exactly."""
    if not rows:
        return []
    step = step or _grid(total_ticks, 45)
    ends = _ends(rows, total_ticks)
    pts = []
    t = rows[0][0]
    while t <= total_ticks:
        i = max(j for j in range(len(rows)) if rows[j][0] <= t)
        pts.append((beats(t), dynamics_math.dynamics_at(t, list(rows[i]), ends[i])))
        t += step
    return pts


def rubato_curve(rows, total_ticks, step=None):
    """Onset displacement in ticks, `rubato_math.warp(t) - t`, over the whole piece.

    Sampled everywhere, not only inside the spans: the displacement really is zero outside
    a span and at every frame boundary (CANONICAL R2/H2), so a full-length curve puts the
    lilt where it happens instead of stretching one span across the panel.
    """
    if not rows:
        return []
    rows = sorted(rows, key=lambda r: r[0])
    ends = _ends(rows, total_ticks)
    step = step or _grid(total_ticks, 15, 900)
    pts, t = [], 0
    while t <= total_ticks:
        i = next((j for j in range(len(rows) - 1, -1, -1)
                  if rows[j][0] <= t < ends[j]), None)
        d = 0.0 if i is None or len(rows[i]) < 3 or rows[i][2] == 1.0 \
            else rubato_math.warp(t, rows[i]) - t
        pts.append((beats(t), d))
        t += step
    return pts


def asynchrony_steps(rows, total_ticks):
    """The staircase of part-2 offsets in ms (a step function of score date, CANONICAL Y1)."""
    if not rows:
        return []
    rows = sorted(rows, key=lambda r: r[0])
    pts = []
    for i, (d, off) in enumerate([(r[0], r[1]) for r in rows]):
        end = rows[i + 1][0] if i + 1 < len(rows) else total_ticks
        pts.append((beats(d), off))
        pts.append((beats(end), off))
    return pts


# --------------------------------------------------------------------------- page pieces

def instruction_tables(maps, gt_maps):
    """Readable per-map instruction tables; ground truth interleaved when the record has it."""
    out = []
    gt = gt_maps or {}

    def rows_for(name, fmt_row, headers, right):
        pred_rows = [fmt_row(r, False) for r in (maps.get(name) or [])]
        gt_rows = [fmt_row(r, True) for r in (gt.get(name) or [])]
        if not pred_rows and not gt_rows:
            return ""
        head = headers if not gt_rows else ["", *headers]
        body = []
        for r in pred_rows:
            body.append(r if not gt_rows else ["predicted", *r])
        for r in gt_rows:
            body.append([f'<span class="muted">ground truth</span>',
                         *[f'<span class="muted">{c}</span>' for c in r]])
        shift = 0 if not gt_rows else 1
        return table(head, body, right={i + shift for i in right})

    def tempo_row(r, _gt):
        d, bpm, to, mta = (list(r) + [None] * 4)[:4]
        return [fnum(beats(d), 2), fnum(bpm, 1),
                "constant" if to is None else f"→ {fnum(to, 1)}",
                "—" if mta is None else fnum(mta, 2)]

    out.append("<h3>tempoMap</h3>")
    out.append(rows_for("tempo", tempo_row, ["date (beat)", "bpm", "transition", "meanTempoAt"],
                        {0, 1, 3}))

    def dyn_row(r, _gt):
        d, vol, to, curv, prot = (list(r) + [None] * 5)[:5]
        return [fnum(beats(d), 2), fnum(vol, 1),
                "constant" if to is None else f"→ {fnum(to, 1)}",
                "—" if curv is None else fnum(curv, 2),
                "—" if prot is None else fnum(prot, 2)]

    out.append("<h3>dynamicsMap</h3>")
    out.append(rows_for("dynamics", dyn_row,
                        ["date (beat)", "volume", "transition", "curvature", "protraction"],
                        {0, 1, 3, 4}))

    def rub_row(r, _gt):
        d, frame, intensity = (list(r) + [None] * 3)[:3]
        kind = ("neutral terminator" if intensity == 1.0
                else ("short–long lilt" if intensity < 1 else "long–short lilt"))
        return [fnum(beats(d), 2), fnum(beats(frame), 2), fnum(intensity, 2), kind]

    out.append("<h3>rubatoMap</h3>")
    out.append(rows_for("rubato", rub_row, ["date (beat)", "frame (beats)", "intensity", ""],
                        {0, 1, 2}) or '<p class="caption">— no rubato span emitted —</p>')

    def asyn_row(r, _gt):
        return [fnum(beats(r[0]), 2), fnum(r[1], 0)]

    out.append("<h3>asynchronyMap (part 2)</h3>")
    out.append(rows_for("asynchrony", asyn_row, ["date (beat)", "offset (ms)"], {0, 1})
               or '<p class="caption">— no asynchrony instruction emitted —</p>')

    artic = maps.get("articulation") or []
    gt_artic = gt.get("articulation") or []
    out.append("<h3>articulationMap (assembled from the per-note heads, part-local)</h3>")
    if artic or gt_artic:
        per_part = {}
        for r in artic:
            per_part.setdefault(r[3] if len(r) > 3 else 1, []).append(r)
        summary = ", ".join(f"part {p}: {len(v)} instructions" for p, v in sorted(per_part.items()))
        head = ["date (beat)", "part", "relativeDuration", "velocityChange"]
        body = [[fnum(beats(r[0]), 2), r[3] if len(r) > 3 else 1, fnum(r[1], 3), fnum(r[2], 1)]
                for r in sorted(artic, key=lambda r: r[0])[:8]]
        out.append(f'<p class="caption">{esc(summary)} — first {len(body)} shown'
                   + (f'; ground truth has {len(gt_artic)} instructions' if gt_artic else "")
                   + ".</p>")
        out.append(table(head, body, right={0, 1, 2, 3}))
    else:
        out.append('<p class="caption">— no note crossed the articulation threshold —</p>')
    return "".join(out)


def input_section(row):
    meta, notes = row.get("meta", {}), row["notes"]
    ppq = meta.get("ppq", PPQ)
    parts = sorted({n[6] if len(n) > 6 else 1 for n in notes})
    ms0 = min(n[3] for n in notes)
    ms1 = max(n[4] for n in notes)
    span_beats = max(n[0] + n[1] for n in notes) / ppq
    kv = [("record id", esc(meta.get("id", row.get("id")))),
          ("source", esc(row["_source"])),
          ("notes", f"{len(notes)} in {len(parts)} part(s)"),
          ("score span", f"{fnum(span_beats, 1)} beats (ppq {ppq})"),
          ("performed span", f"{fnum((ms1 - ms0) / 1000, 2)} s")]
    for key, label in (("piece", "piece"), ("pianist", "pianist"), ("source_id", "source id"),
                       ("window_start_beat", "window start (beat)"),
                       ("window_beats", "window length (beats)"),
                       ("window_start_ms", "window start (ms in the recording)"),
                       ("seed", "sampler seed"), ("renderer", "renderer"),
                       ("total_ticks", "total ticks")):
        if key in meta:
            v = meta[key]
            kv.append((label, esc(fnum(v, 1) if isinstance(v, float) else v)))
    meta_table = table(["field", "value"], [[esc(k), v] for k, v in kv])

    rows = []
    for part in parts:
        first = [n for n in notes if (n[6] if len(n) > 6 else 1) == part][:4]
        for i, n in enumerate(first):
            rows.append([f"part {part}" if i == 0 else "", fnum(n[0] / ppq, 2),
                         fnum(n[1] / ppq, 2),
                         f"<span class='nowrap'>{pitch_name(n[2])} "
                         f"<span class='muted'>({int(n[2])})</span></span>",
                         fnum(n[3], 1), fnum(n[4], 1),
                         fnum(n[5] if len(n) > 5 else 100.0, 1)])
    onsets = table(["", "score (beat)", "dur (beats)", "pitch", "performed on (ms)",
                    "off (ms)", "velocity"], rows, right={1, 2, 4, 5, 6})
    return ('<h2>Input — the performance the model sees</h2>'
            '<p>Per-note rows <code>[score ticks, duration, pitch, performed ms on, ms off, '
            'velocity, part]</code>; the model reads them as the 16 conditioning features of '
            '<code>dataset.piece_to_features_v41</code> and nothing else — no score image, no '
            'MPM, no metadata.</p>'
            f'<h3>record</h3>{meta_table}'
            f'<h3>first onsets, per part</h3>{onsets}')


def overlay_section(row):
    notes, render = row["notes"], row["render"]
    ppq = row.get("meta", {}).get("ppq", PPQ)
    order = sorted(range(len(notes)), key=lambda i: (notes[i][0], notes[i][2]))
    perf = [(notes[i][0] / ppq, notes[i][3] / 1000.0) for i in order]
    pred = [(notes[i][0] / ppq, render["pred_ms_on"][i] / 1000.0) for i in order
            if render["pred_ms_on"][i] is not None]
    base = [(notes[i][0] / ppq, render["base_ms_on"][i] / 1000.0) for i in order
            if render["base_ms_on"][i] is not None]
    series = [
        {"name": "baseline", "points": base, "color": "muted", "dash": "5 4",
         "tip": "constant-tempo baseline: one bpm mapping total beats to total seconds"},
        {"name": "re-rendered", "points": pred, "color": "accent",
         "tip": "the emitted MPM rendered back through the exact meico chain"},
        {"name": "performed", "points": perf, "color": "ink", "width": 2.0,
         "tip": "the pianist's actual onsets"},
    ]
    res_pred = [(notes[i][0] / ppq, render["pred_ms_on"][i] - notes[i][3]) for i in order
                if render["pred_ms_on"][i] is not None]
    res_base = [(notes[i][0] / ppq, render["base_ms_on"][i] - notes[i][3]) for i in order
                if render["base_ms_on"][i] is not None]
    res_series = [
        {"name": "baseline", "points": res_base, "color": "muted", "dash": "5 4",
         "tip": "baseline onset minus performed onset"},
        {"name": "re-rendered", "points": res_pred, "color": "accent",
         "tip": "re-rendered onset minus performed onset"},
    ]
    verdict = ("below" if row["render_rmse"] < row["base_render_rmse"] else "above")
    return ('<h2>Round trip — the emitted MPM rendered back</h2>'
            '<p>The MPM above, rendered through the same exact chain the evaluator uses '
            '(<code>perf_chain_v4</code>, ULP-verified against the Java fork), against the '
            'onsets actually played and against a single constant tempo fitted to the '
            'window. Three curves of the same quantity on one axis: elapsed time.</p>'
            + chart_block(series, x_label="score position (beats)",
                          y_label="performed time (s)",
                          caption="Every point is one note, ordered by score position.")
            + chart_block(res_series, x_label="score position (beats)",
                          y_label="onset error (ms)", zero_line=True, height=220,
                          caption=f"Signed residual against the performance. The prediction's "
                                  f"RMSE ({fnum(row['render_rmse'], 0)} ms) is {verdict} the "
                                  f"constant-tempo baseline's "
                                  f"({fnum(row['base_render_rmse'], 0)} ms)."))


def decomposition_section(row):
    maps, gt = row["maps_rendered"], row.get("gt_maps") or {}
    total = row.get("meta", {}).get("total_ticks") or max(n[0] + n[1] for n in row["notes"])
    blocks = []

    t_series = [{"name": "predicted", "points": tempo_curve(maps.get("tempo"), total),
                 "color": "accent", "tip": "tempo curve of the emitted tempoMap"}]
    if gt.get("tempo"):
        t_series.append({"name": "ground truth", "points": tempo_curve(gt["tempo"], total),
                         "color": "ink", "dash": "4 3", "tip": "the sampled tempoMap"})
    n_t = len(maps.get("tempo") or [])
    blocks.append(spark("tempo curve", t_series, y_label="bpm", x_label="beats",
                        caption=f"{n_t} instruction(s), evaluated with "
                                f"<code>tempo_math.tempo_at</code> (meico's power function)."))

    d_series = [{"name": "predicted", "points": dynamics_curve(maps.get("dynamics"), total),
                 "color": "accent", "tip": "volume curve of the emitted dynamicsMap"}]
    if gt.get("dynamics"):
        d_series.append({"name": "ground truth",
                         "points": dynamics_curve(gt["dynamics"], total),
                         "color": "ink", "dash": "4 3", "tip": "the sampled dynamicsMap"})
    n_d = len(maps.get("dynamics") or [])
    blocks.append(spark("dynamics curve", d_series, y_label="volume", x_label="beats",
                        caption=f"{n_d} instruction(s), evaluated with "
                                f"<code>dynamics_math.dynamics_at</code> (meico's Bézier)."))

    r_series = [{"name": "predicted", "points": rubato_curve(maps.get("rubato"), total),
                 "color": "accent", "tip": "warp(t) − t inside each rubato frame"}]
    if gt.get("rubato"):
        r_series.append({"name": "ground truth", "points": rubato_curve(gt["rubato"], total),
                         "color": "ink", "dash": "4 3", "tip": "the sampled rubatoMap"})
    n_spans = sum(1 for r in (maps.get("rubato") or []) if len(r) > 2 and r[2] != 1.0)
    blocks.append(spark("rubato frames", [s for s in r_series if s["points"]],
                        y_label="onset displacement (ticks)", x_label="beats", zero_line=True,
                        caption=f"{n_spans} open span(s); the sawtooth is one frame, zero at "
                                f"every frame boundary (R2). <code>rubato_math.warp</code>."))

    a_series = [{"name": "predicted", "points": asynchrony_steps(maps.get("asynchrony"), total),
                 "color": "accent", "tip": "part-2 offset in ms"}]
    if gt.get("asynchrony"):
        a_series.append({"name": "ground truth",
                         "points": asynchrony_steps(gt["asynchrony"], total),
                         "color": "ink", "dash": "4 3", "tip": "the sampled asynchronyMap"})
    n_a = len(maps.get("asynchrony") or [])
    blocks.append(spark("asynchrony steps", [s for s in a_series if s["points"]],
                        y_label="part-2 offset (ms)", x_label="beats", zero_line=True,
                        caption=f"{n_a} step(s). A positive offset delays part 2, i.e. the "
                                f"melody leads by that many ms."))
    return ('<h2>Per-map decomposition</h2>'
            '<p>What each emitted map contributes, in its own units, evaluated with the '
            'renderer\'s own math on the rows printed above.</p>'
            f'<div class="sparks">{"".join(blocks)}</div>')


def metrics_section(row):
    def pct(a, b):
        if not b or b != b:
            return "—"
        return f"{(a - b) / b * 100:+.0f}%"

    rows = [["onset RMSE (ms)", fnum(row["render_rmse"], 1), fnum(row["base_render_rmse"], 1),
             pct(row["render_rmse"], row["base_render_rmse"])],
            ["note-off RMSE (ms)", fnum(row["off_rmse"], 1), fnum(row["base_off_rmse"], 1),
             pct(row["off_rmse"], row["base_off_rmse"])],
            ["velocity RMSE", fnum(row["vel_rmse"], 2), fnum(row["base_vel_rmse"], 2),
             pct(row["vel_rmse"], row["base_vel_rmse"])]]
    out = ['<h2>Metrics for this record</h2>',
           '<p>Render-space first, because it is the only space that needs no ground-truth '
           'MPM: the prediction is rendered and compared against what was played. The '
           'baseline is one constant tempo fitted to this window — the honest null.</p>',
           table(["quantity", "prediction", "baseline", "vs baseline"], rows,
                 right={1, 2, 3})]
    extra = [["DSL tokens emitted", fnum(row["dl_tokens"], 0)],
             ["parse errors", fnum(row["parse_errors"], 0)],
             ["tempo instructions", fnum(row["n_tempo"], 0)],
             ["notes the articulation head fired on",
              f'{fnum(row.get("n_artic_pred"), 0)} / {row["n_notes"]}'],
             ["pedal-state MAE (CC units)", fnum(row.get("pedal_state_mae"), 2)],
             ["non-finite renders", fnum(row.get("n_nonfinite"), 0)]]
    out.append(table(["diagnostic", "value"], extra, right={1}))
    gtm = row.get("metrics_gt")
    if gtm:
        gt_rows = [["tempo boundary F1", fnum(gtm.get("boundary_f1"), 2)],
                   ["dynamics boundary F1", fnum(gtm.get("dyn_boundary_f1"), 2)],
                   ["rubato F1", fnum(gtm.get("rubato_f1"), 2)],
                   ["asynchrony offset error (ms)",
                    f'{fnum(gtm.get("asyn_offset_err"), 2)} '
                    f'(baseline {fnum(gtm.get("base_asyn_offset_err"), 2)})'],
                   ["articulation note F1", fnum(gtm.get("artic_note_f1"), 2)],
                   ["articulation relDur MAE", fnum(gtm.get("artic_reldur_mae"), 3)],
                   ["articulation velocity MAE", fnum(gtm.get("artic_vel_mae"), 2)],
                   ["MDL ratio (trained subset)", fnum(gtm.get("mdl_ratio_subset"), 2)],
                   ["MDL ratio (full document)", fnum(gtm.get("mdl_ratio_full"), 2)],
                   ["sustain-CC RMSE / CC64 agreement",
                    f'{fnum(gtm.get("cc_rmse"), 1)} / {fnum(gtm.get("cc64_agree"), 2)}']]
        out.append('<h3>against the ground-truth MPM (synthetic record only)</h3>')
        out.append('<p class="caption">This record was <em>generated</em> from a known MPM, so '
                   'curve-space and instruction-space comparisons are defined here and are '
                   'undefined on real data.</p>')
        out.append(table(["quantity", "value"], gt_rows, right={1}))
    return "".join(out)


def caveats(row, xml_notes):
    """The footer, written from this record's own numbers — not a fixed paragraph."""
    items = []
    r, b = row["render_rmse"], row["base_render_rmse"]
    if r > b:
        items.append(f"<b>Timing is worse than the null here.</b> The predicted maps render "
                     f"onsets at {fnum(r, 0)} ms RMSE; one constant tempo fitted to the same "
                     f"window gets {fnum(b, 0)} ms — a factor {r / b:.1f} against the model. "
                     f"The tempo map is carrying a shape the performance does not have.")
    else:
        items.append(f"Onset RMSE {fnum(r, 0)} ms against the constant-tempo null's "
                     f"{fnum(b, 0)} ms ({(r - b) / b * 100:+.0f}%). RMSE is dominated by "
                     f"accumulated drift, not by local error: a small constant tempo bias "
                     f"integrates over the window.")
    v, vb = row["vel_rmse"], row["base_vel_rmse"]
    items.append(f"Velocity RMSE {fnum(v, 2)} against the null's {fnum(vb, 2)} "
                 f"({(v - vb) / vb * 100:+.0f}%).")
    if row.get("n_artic_pred") is not None:
        frac = row["n_artic_pred"] / max(row["n_notes"], 1)
        if frac > 0.35 and not row.get("gt_maps"):
            items.append(f"<b>The articulation head over-fires on real playing:</b> "
                         f"{row['n_artic_pred']} of {row['n_notes']} notes "
                         f"({frac * 100:.0f}%). It was trained on canonical synthetic data "
                         f"where ~15% of onset dates carry an articulation (CANONICAL A1); a "
                         f"human deviates everywhere, so every note looks articulated. "
                         f"Thresholding and era priors are the v1.0 answer.")
    if not row.get("gt_maps"):
        items.append("<b>No ground truth exists for this record.</b> Nothing on this page is "
                     "a curve-space or instruction-space score — there is no reference MPM to "
                     "compare instructions against. Every number is render-space: the "
                     "prediction rendered and measured against the performance.")
    else:
        items.append("This is a <em>synthetic</em> record: its performance was rendered from a "
                     "known MPM, so the model is being asked to invert a process it was "
                     "trained on. Real-data behaviour is the Vienna probe, not this page.")
    if row.get("metrics_gt", {}).get("pedal_state_mae") is not None:
        items.append("The pedal head's state MAE is <b>contaminated on synthetic data</b> — "
                     "the target leaks into input feature 14. It is a known v1.0 design "
                     "correction, so read the pedal number as diagnostic only.")
    items.append("<b>No movementMap in the emitted document.</b> Pedal is predicted per note "
                 "as a state; turning states back into movement instructions is the v1.1 "
                 "reconstruction pass (SYSTEM.md §4). Ornaments and imprecision are likewise "
                 "out of the v1.0 vocabulary. Where a sustain-CC number is reported it "
                 "therefore scores a document with no pedal in it — it is the no-pedal null, "
                 "not a pedal prediction.")
    gtm = row.get("metrics_gt") or {}
    weak = [(name, gtm[key]) for key, name in (("boundary_f1", "tempo boundary"),
                                               ("dyn_boundary_f1", "dynamics boundary"),
                                               ("rubato_f1", "rubato span"))
            if isinstance(gtm.get(key), (int, float)) and gtm[key] < 0.75]
    if weak:
        items.append("Instruction-space agreement is partial here — "
                     + ", ".join(f"{n} F1 {v:.2f}" for n, v in weak)
                     + " (±1 beat tolerance). That is the expected shape of the problem, not "
                       "a contradiction of the render numbers: several different instruction "
                       "sets render nearly the same performance, and the MDL ratio says this "
                       "one spends about as many tokens as the truth did "
                       f"({fnum(gtm.get('mdl_ratio_subset'), 2)} of the ground truth's "
                       "subset cost).")
    items.extend(xml_notes)
    m = row["model"]
    ckpt = "/".join(Path(m["ckpt"]).parts[-3:])
    items.append(f"Single seed, single checkpoint (<code>{esc(ckpt)}</code>, epoch "
                 f"{m['epoch']}, {m['n_params']:,} parameters, {m['n_features']} features, "
                 f"heads {'on' if m['heads'] else 'off'}), trained purely on synthetic "
                 f"renderings. One record is an illustration, never evidence — the evidence "
                 f"is the 1000-piece validation and the 220-window Vienna probe in "
                 f"<code>ml/LOG.md</code>.")
    lis = "".join(f"<li>{it}</li>" for it in items)
    return f'<h2>Honest caveats</h2><ul class="footnote">{lis}</ul>'


def provenance(row, source):
    """Every figure on the page, and the JSON key it came from."""
    rows = [
        ["input tables, overlay x-axis", "<code>notes</code>", "verbatim"],
        ["performed curve", "<code>notes[i][3]</code>", "ms → s"],
        ["re-rendered curve, residual", "<code>render.pred_ms_on</code>",
         "minus <code>notes[i][3]</code>"],
        ["baseline curve, residual", "<code>render.base_ms_on</code>",
         f"from <code>render.base_tempo</code> = {fnum(row['render']['base_tempo'][0][1], 2)} bpm"],
        ["instruction tables", "<code>maps</code>, <code>maps_rendered</code>", "verbatim"],
        ["articulation table", "<code>maps_rendered.articulation</code>",
         "assembled by <code>evaluate.note_preds_to_articulation</code> from "
         "<code>note_pred</code>"],
        ["MPM XML", "<code>maps_rendered</code>",
         "this file's <code>maps_to_mpm_full</code> (byte-exact against "
         "<code>ml/node/xml.mjs</code> on 100 pilot records)"],
        ["tempo / dynamics sparklines", "<code>maps_rendered.tempo/.dynamics</code>",
         "<code>tempo_math.tempo_at</code>, <code>dynamics_math.dynamics_at</code>"],
        ["rubato sparkline", "<code>maps_rendered.rubato</code>",
         "<code>rubato_math.warp(t) − t</code>"],
        ["asynchrony sparkline", "<code>maps_rendered.asynchrony</code>", "step function"],
        ["metrics table", "<code>render_rmse</code>, <code>off_rmse</code>, "
         "<code>vel_rmse</code>, <code>base_*</code>, <code>pedal_state_mae</code>, "
         "<code>dl_tokens</code>, <code>parse_errors</code>, <code>n_tempo</code>, "
         "<code>n_artic_pred</code>", "verbatim"],
    ]
    if row.get("metrics_gt"):
        rows.append(["ground-truth metrics, GT curves", "<code>metrics_gt</code>, "
                     "<code>gt_maps</code>", "verbatim / same math as the predicted curves"])
    return ('<h2>Provenance</h2>'
            f'<p>This page is a rendering of <code>{esc(Path(source).name)}</code> '
            f'(<code>infer_v4.py --dump-maps</code>) and of nothing else: the generator does '
            f'not re-run the model and does not re-render. <code>--dump-maps</code> itself '
            f're-renders the maps it writes and refuses to produce the file unless the '
            f'result reproduces the evaluator\'s RMSEs bit for bit, so a number traceable to '
            f'this file is a number traceable to the evaluated prediction. Every figure and '
            f'its key:</p>'
            + table(["on the page", "key in the preds JSON", "transform"], rows))


# --------------------------------------------------------------------------- assembly

def build_page(row, source, template, css, title=None):
    maps = row["maps_rendered"]
    xml = maps_to_mpm_full(maps, notes=row["notes"],
                           ppq=row.get("meta", {}).get("ppq", PPQ),
                           name=str(row.get("id", "perf")))
    xml_notes = []
    raw_tempo = row["maps"].get("tempo") or []
    if not raw_tempo or raw_tempo[0][0] != 0:
        xml_notes.append("The decoder emitted no tempo instruction at date 0, so the "
                         "evaluator's fallback (<code>100 bpm</code> at date 0) is in the "
                         "rendered map and therefore in the XML — it is not a prediction.")
    if row["parse_errors"]:
        xml_notes.append(f"<b>{row['parse_errors']} DSL parse error(s)</b> in this record's "
                         f"token stream; the affected productions were dropped by "
                         f"<code>dsl.decode_piece_v4</code>'s tolerant parser.")
    artic = maps.get("articulation") or []
    if any(round(r[1], 2) != r[1] or float(r[2]).is_integer() is False for r in artic):
        xml_notes.append("The articulationMap's values are the heads' raw regression outputs "
                         "— unrounded floats, where the canonical form is 2 decimals for "
                         "<code>relativeDuration</code> and an integer for "
                         "<code>absoluteVelocityChange</code> (CANONICAL A2/A3). They are "
                         "written as predicted because they are what was rendered and "
                         "scored; a canonicalisation pass belongs in the export path.")

    meta = row.get("meta", {})
    real = "pianist" in meta
    if real:
        piece = str(meta.get("piece", "")).replace("_", " ")
        h1 = title or f"{piece} — a real performance in, a readable MPM out"
        corpus = ("the Vienna 4x22 corpus — real Bösendorfer data"
                  if "vienna" in str(row.get("_source", "")).lower()
                  else "a real recorded performance")
        lede = (f'<p class="muted">Model <code>{esc(Path(row["model"]["ckpt"]).parent.name)}'
                f'</code> ({row["model"]["n_params"]:,}-param hybrid: DSL decoder + per-note '
                f'heads), trained <em>purely on synthetic renderings</em>, applied to a '
                f'{meta.get("window_beats", "?")}-beat window of {esc(piece)} played by '
                f'pianist {esc(meta.get("pianist"))} ({corpus} the '
                f'model has never seen). There is no ground-truth MPM for this window: '
                f'everything below is measured by rendering the prediction back.</p>')
    else:
        h1 = title or f"Synthetic validation piece #{row.get('id')} — inverted back to MPM"
        lede = (f'<p class="muted">Model <code>{esc(Path(row["model"]["ckpt"]).parent.name)}'
                f'</code> ({row["model"]["n_params"]:,}-param hybrid: DSL decoder + per-note '
                f'heads) on a held-out <code>val_v4</code> record. This performance was '
                f'<em>rendered from a known MPM</em>, so every predicted instruction can be '
                f'put next to the instruction that actually produced the notes — the ground-'
                f'truth rows below and the dashed curves in every panel.</p>')

    body = [
        input_section(row),
        '<h2>Output — the emitted MPM</h2>',
        f'<p>{row["dl_tokens"]} DSL tokens, {row["parse_errors"]} parse errors, decoded into '
        f'the maps below and compiled to MPM XML. The decoder is responsible for tempo, '
        f'dynamics, rubato and asynchrony; articulation comes from the per-note heads and is '
        f'assembled into a part-local map (CANONICAL A6).</p>',
        instruction_tables(maps, row.get("gt_maps")),
        '<h3>compiled MPM</h3>',
        '<p class="caption">Written by this page\'s own port of the generator\'s MPM writer '
        '(<code>ml/node/xml.mjs</code>) — the writer whose documents both meico and '
        'espressivo parse, checked byte-for-byte against its output on 100 pilot records. '
        'One element per line for reading; the writer emits a single line, nothing else '
        'differs.</p>',
        f'<pre class="xml">{esc(indent_xml(xml))}</pre>',
        overlay_section(row),
        decomposition_section(row),
        metrics_section(row),
        caveats(row, xml_notes),
        provenance(row, source),
    ]
    page = (template
            .replace("{{CSS}}", css)
            .replace("{{TITLE}}", esc(f"fenby · {h1}"))
            .replace("{{EYEBROW}}",
                     f"fenby · demonstration · {date.today():%d %b %Y}")
            .replace("{{H1}}", esc(h1))
            .replace("{{LEDE}}", lede)
            .replace("{{BODY}}", "\n".join(body)))
    return page


def load_preds(path, record_id):
    data = json.loads(Path(path).read_text())
    rows = data if isinstance(data, list) else data.get("records", [])
    for row in rows:
        if record_id is None or str(row.get("id")) == str(record_id):
            if "maps_rendered" not in row:
                raise SystemExit(f"{path}: record {row.get('id')} has no dumped maps — "
                                 f"re-run infer_v4.py with --dump-maps")
            return row
    raise SystemExit(f"{path}: no record with id {record_id!r}")


def run_inference(ckpt, data, record_id, out_json):
    import subprocess
    cmd = [sys.executable, "infer_v4.py", "--ckpt", str(Path(ckpt).resolve()),
           "--id", str(record_id), "--dump-maps", "--out", str(Path(out_json).resolve()),
           str(Path(data).resolve())]
    print("$ " + " ".join(cmd))
    subprocess.run(cmd, cwd=HERE.parent / "python", check=True)
    return out_json


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--preds", help="preds JSON from infer_v4.py --dump-maps")
    ap.add_argument("--ckpt", help="checkpoint; runs infer_v4.py when --preds is absent")
    ap.add_argument("--data", help="records JSONL (with --ckpt)")
    ap.add_argument("--id", help="record id to demonstrate")
    ap.add_argument("--out", help="output HTML path")
    ap.add_argument("--title", help="override the page headline")
    ap.add_argument("--selftest", action="store_true",
                    help="check the MPM writer byte-for-byte against ml/node/xml.mjs output")
    args = ap.parse_args(argv)

    if args.selftest:
        return 0 if selftest() else 1
    if not args.out:
        ap.error("--out is required")
    preds = args.preds
    if not preds:
        if not (args.ckpt and args.data and args.id):
            ap.error("give --preds, or --ckpt/--data/--id to run inference")
        preds = str(Path(args.out).with_suffix(".preds.json"))
        run_inference(args.ckpt, args.data, args.id, preds)
    row = load_preds(preds, args.id)
    row["_source"] = str(args.data or preds)
    page = build_page(row, preds, (HERE / "demo_template.html").read_text(),
                      (HERE / "demo.css").read_text(), title=args.title)
    if re.search(r"""(src|href)\s*=\s*["']https?:""", page):
        raise SystemExit("page contains an external reference — it must be self-contained")
    Path(args.out).write_text(page)
    print(f"wrote {args.out} ({len(page.encode()) / 1024:.0f} KB) from {preds}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
