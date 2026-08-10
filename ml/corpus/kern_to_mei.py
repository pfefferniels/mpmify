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

3b. **``expandNever``.** Verovio resolves repeats/expansions *inline* — its MIDI and timemap
   play the repeat, with fresh ``xml:id``s for the copies — while meico defers them to an MSM
   ``<sequencingMap>`` of ``<goto>``s, and the two disagree about the result (on Chopin
   op. 33/3 Verovio produces 717 note-ons where meico's own resolver produces 504). With
   ``expandNever`` on, the MEI, the MIDI and the timemap all describe the score **as written,
   once through** — 389 notes, 389 note-ons, 389 distinct ids on that same piece — which is
   the only configuration in which the three are comparable at all. The corpus is therefore
   the unexpanded score; resolving repeats consistently on both sides is v1.1 work.

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

        warnings = [ln for ln in log.splitlines() if ln.strip()]
        entry = {
            "id": rec["id"],
            "era": rec["era"],
            "ok": True,
            "pages": pages,
            "mei_bytes": len(mei),
            "mei_note_elements": mei.count("<note "),
            "timemap_note_ons": sum(len(e.get("on", [])) for e in timemap),
            "timemap_max_qstamp": max((e["qstamp"] for e in timemap), default=0),
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
        "files": out,
    }
    with open(os.path.join(mei_dir, "convert.json"), "w") as f:
        json.dump(meta, f, indent=2)
    bad = [e for e in out if not e.get("ok")]
    sys.stdout.write(
        f"\nverovio {version}: {len(out) - len(bad)}/{len(out)} converted, "
        f"{sum(e.get('n_warnings', 0) for e in out)} warnings total -> {mei_dir}/convert.json\n"
    )
    return 1 if bad else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--data", default=os.path.join(here, "..", "data", "corpus_pilot"))
    ap.add_argument("--only", nargs="*", default=None)
    a = ap.parse_args()
    sys.exit(convert(os.path.abspath(a.data), a.only))
