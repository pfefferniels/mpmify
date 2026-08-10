#!/usr/bin/env python3
"""Step 2: Humdrum **kern -> MEI, with Verovio's traps handled explicitly.

    nice -n 15 python3 kern_to_mei.py [--data ../data/corpus_pilot] [--only ID ...]

Writes ``mei/<id>.mei`` and ``midi/<id>.mid`` plus ``mei/convert.json`` (per-file timings,
note counts, Verovio's own warnings).

Three things about this step are not obvious and each has cost somebody a day:

1. **The pip package, never the CLI.** ``verovio`` the command-line tool renders and exports
   *the current page*, so a multi-page score silently converts to its first page. The pilot
   study caught this after the fact by note counts. Here the toolkit is used directly and MEI
   is requested as ``{"scoreBased": True, "pageNo": 0}`` — ``pageNo`` 0 means "all pages", and
   ``scoreBased`` means score-based MEI rather than the page-based layout tree, which is what
   meico's MEI importer expects. The version is pinned in ``requirements`` terms by recording
   ``toolkit.getVersion()`` into ``convert.json``: a corpus converted by two Verovio versions
   is two corpora.

2. **The MIDI export and the timemap are not decoration.** ``renderToMIDI`` gives an
   independent realisation of the same score from the same parser, so the MSM produced two
   steps later can be checked against it note for note (``score_check.py``). That check is
   what catches meico's 8va double-shift — Verovio applies the octave displacement once, meico
   applies it again on top of ``@oct.ges`` — and it catches it as a *pitch* difference rather
   than as a plausible-looking score. ``renderToTimemap`` gives the same realisation keyed by
   ``xml:id`` with a ``qstamp`` in quarter notes, which is what ``build_msm.mjs`` uses to
   re-date the MSM (see the incomplete-measure pad it repairs). Neither can catch a Verovio
   defect (a cross-octave accidental carry is in every output by construction); that limit is
   stated rather than papered over.

3b. **``expandNever``, and the expansion probe that measures why.** Verovio resolves
   repeats/expansions *inline* — its MIDI and timemap play the repeat, with fresh ``xml:id``s
   for the copies — while meico defers them to an MSM ``<sequencingMap>`` of ``<goto>``s. The
   two do not agree about the result, and the corpus therefore takes neither: with
   ``expandNever`` on, the MEI, the MIDI and the timemap all describe the score **as written,
   once through**, which is the only configuration in which the three are comparable at all.

   The disagreement used to be quoted from an uncommitted run ("717 note-ons against 504"),
   which is a number nobody could re-derive. It is now **measured by this script**: every file
   is converted twice, once with ``expandNever`` and once with Verovio's expansion on, and both
   note-on counts go into ``mei/expansion_probe.json``. ``build_msm.mjs`` records the third
   number — what ``Msm.resolveSequencingMaps()`` would produce — into ``msm/index.json`` as
   ``resolvedNotes``. Whether the two expansions agree is then a table lookup, not a memory.
   Resolving repeats consistently on both sides is v1.1 work.

3. **Verovio talks.** Its log is a global side channel, not an exception: ``ExpansionMap``
   complaints, unresolved ``@plist`` targets and unsupported elements all arrive there. They
   are captured per file and stored, because "converted with 4 warnings" and "converted" are
   different facts about a score.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time

import verovio


def _note_ons(midi_b64: str) -> int:
    """Note-ons in a base64 SMF, counted without leaving this process.

    A minimal SMF reader rather than a dependency: the only question asked of the bytes is how
    many note-on events with velocity > 0 they contain, and the expansion probe has to ask it
    of a MIDI file that is never written to disk.
    """
    data = base64.b64decode(midi_b64)
    pos, count = 0, 0
    if data[0:4] != b"MThd":
        raise ValueError("not a standard MIDI file")
    ntrk = int.from_bytes(data[10:12], "big")
    pos = 8 + int.from_bytes(data[4:8], "big")
    for _ in range(ntrk):
        assert data[pos : pos + 4] == b"MTrk", "malformed track chunk"
        end = pos + 8 + int.from_bytes(data[pos + 4 : pos + 8], "big")
        pos += 8
        status = 0
        while pos < end:
            while data[pos] & 0x80:  # variable-length delta time
                pos += 1
            pos += 1
            b = data[pos]
            if b & 0x80:
                status = b
                pos += 1
            if status == 0xFF:  # meta
                pos += 1
                length = 0
                while data[pos] & 0x80:
                    length = (length << 7) | (data[pos] & 0x7F)
                    pos += 1
                length = (length << 7) | data[pos]
                pos += 1 + length
            elif status in (0xF0, 0xF7):  # sysex
                length = 0
                while data[pos] & 0x80:
                    length = (length << 7) | (data[pos] & 0x7F)
                    pos += 1
                length = (length << 7) | data[pos]
                pos += 1 + length
            else:
                high = status & 0xF0
                nbytes = 1 if high in (0xC0, 0xD0) else 2
                if high == 0x90 and data[pos + 1] > 0:
                    count += 1
                pos += nbytes
        pos = end
    return count


def convert(data_dir: str, only: list[str] | None) -> int:
    fetched_path = os.path.join(data_dir, "fetched.json")
    if not os.path.exists(fetched_path):
        sys.stderr.write(f"no {fetched_path} — run fetch_scores.mjs first\n")
        return 2
    fetched = json.load(open(fetched_path))

    mei_dir = os.path.join(data_dir, "mei")
    midi_dir = os.path.join(data_dir, "midi")
    tmap_dir = os.path.join(data_dir, "timemap")
    os.makedirs(mei_dir, exist_ok=True)
    os.makedirs(midi_dir, exist_ok=True)
    os.makedirs(tmap_dir, exist_ok=True)

    verovio.enableLog(False)  # keep stderr clean; the log is read back per file instead
    tk = verovio.toolkit()
    version = tk.getVersion()
    # A SECOND toolkit, identical but for `expandNever`, so the expansion disagreement is a
    # measurement of this run rather than a remembered number. Two toolkits rather than one
    # re-configured toolkit: `expandNever` is consumed at load time, so the option has to be
    # set before `loadFile`, and keeping them separate makes it impossible to leak the probe's
    # setting into the corpus conversion.
    tk_expanded = verovio.toolkit()
    tk_expanded.setOptions(
        {"breaks": "none", "adjustPageHeight": True, "footer": "none", "header": "none", "expandNever": False}
    )
    # Defaults that matter for a *data* conversion rather than an engraving:
    #  - breaks=none keeps the whole movement in one flow (page breaks are layout, and the
    #    page tree is what the CLI truncates);
    #  - the tuplet/beam options are left alone; they do not reach the MEI's logical layer.
    tk.setOptions(
        {"breaks": "none", "adjustPageHeight": True, "footer": "none", "header": "none", "expandNever": True}
    )

    out = []
    for rec in fetched["files"]:
        if only and rec["id"] not in only:
            continue
        src = os.path.join(data_dir, rec["local"])
        t0 = time.time()
        ok = tk.loadFile(src)
        if not ok:
            out.append({"id": rec["id"], "ok": False, "error": "verovio loadFile returned False"})
            sys.stderr.write(f"FAIL {rec['id']}: loadFile\n")
            continue
        pages = tk.getPageCount()
        mei = tk.getMEI({"scoreBased": True, "pageNo": 0})
        midi_b64 = tk.renderToMIDI()
        timemap = tk.renderToTimemap({"includeMeasures": True, "includeRests": False})
        log = tk.getLog()
        dt = time.time() - t0

        with open(os.path.join(mei_dir, rec["id"] + ".mei"), "w") as f:
            f.write(mei)
        with open(os.path.join(midi_dir, rec["id"] + ".mid"), "wb") as f:
            f.write(base64.b64decode(midi_b64))
        with open(os.path.join(tmap_dir, rec["id"] + ".json"), "w") as f:
            json.dump(timemap, f)

        # The expansion probe: the SAME file through the SAME parser with the repeats played.
        # Its output is thrown away except for the two counts — nothing downstream ever sees an
        # expanded document — and the counts are what make trap 7 checkable.
        exp_note_ons, exp_mei_notes, exp_warnings = None, None, []
        if tk_expanded.loadFile(src):
            exp_note_ons = _note_ons(tk_expanded.renderToMIDI())
            exp_mei_notes = tk_expanded.getMEI({"scoreBased": True, "pageNo": 0}).count("<note ")
            exp_warnings = [ln for ln in tk_expanded.getLog().splitlines() if ln.strip()]

        warnings = [ln for ln in log.splitlines() if ln.strip()]
        entry = {
            "id": rec["id"],
            "era": rec["era"],
            "ok": True,
            "pages": pages,
            "mei_bytes": len(mei),
            "mei_note_elements": mei.count("<note "),
            "midi_note_ons": _note_ons(midi_b64),
            "timemap_note_ons": sum(len(e.get("on", [])) for e in timemap),
            "timemap_distinct_on_ids": len({i for e in timemap for i in e.get("on", [])}),
            "timemap_max_qstamp": max((e["qstamp"] for e in timemap), default=0),
            "kern_repeat_barlines": sum(
                1 for ln in open(src, encoding="utf8", errors="replace") if ":|" in ln or "|:" in ln
            ),
            "expanded_midi_note_ons": exp_note_ons,
            "expanded_mei_note_elements": exp_mei_notes,
            "expanded_warnings": exp_warnings[:10],
            "seconds": round(dt, 3),
            "warnings": warnings[:20],
            "n_warnings": len(warnings),
        }
        out.append(entry)
        sys.stdout.write(
            f"{rec['id']:34s} {rec['era']:9s} pages {pages:2d} mei {len(mei)/1024:7.1f} kB "
            f"notes {entry['mei_note_elements']:5d} {dt:6.2f} s  warn {len(warnings)}\n"
        )

    meta = {
        "verovio_version": version,
        "options": {"scoreBased": True, "pageNo": 0, "expandNever": True, "breaks": "none"},
        "expansion_probe": "every file is ALSO converted with expandNever=False; only the two "
        "counts are kept (expanded_midi_note_ons / expanded_mei_note_elements). Nothing "
        "downstream consumes an expanded document.",
        "files": out,
    }
    with open(os.path.join(mei_dir, "convert.json"), "w") as f:
        json.dump(meta, f, indent=2)
    bad = [e for e in out if not e.get("ok")]
    sys.stdout.write(
        f"\nverovio {version}: {len(out) - len(bad)}/{len(out)} converted, "
        f"{sum(e.get('n_warnings', 0) for e in out)} warnings total -> {mei_dir}/convert.json\n"
    )
    grew = [e for e in out if e.get("ok") and e.get("expanded_midi_note_ons") != e.get("midi_note_ons")]
    sys.stdout.write(
        f"expansion probe: Verovio's own expansion changes the note count on "
        f"{len(grew)}/{len(out) - len(bad)} files\n"
    )
    for e in grew:
        sys.stdout.write(
            f"  {e['id']:34s} repeat barlines {e['kern_repeat_barlines']:2d}  "
            f"note-ons {e['midi_note_ons']:5d} -> {e['expanded_midi_note_ons']:5d}\n"
        )
    return 1 if bad else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--data", default=os.path.join(here, "..", "data", "corpus_pilot"))
    ap.add_argument("--only", nargs="*", default=None)
    a = ap.parse_args()
    sys.exit(convert(os.path.abspath(a.data), a.only))
