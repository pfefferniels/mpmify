"""Validate generated JSONL: recompute every note's ms onset/offset from the MPM
tempo map with the Python port and compare against meico's rendered values."""

import json
import sys

from tempo_math import TempoTimeline

path = sys.argv[1] if len(sys.argv) > 1 else "../data/pilot.jsonl"
max_on = max_off = 0.0
n_notes = 0
pieces = 0
for line in open(path):
    rec = json.loads(line)
    tl = TempoTimeline(rec["tempo"])
    for date, dur, pitch, ms_on, ms_off, *_ in rec["notes"]:
        p_on = tl.ms_at(date)
        p_off = tl.ms_at(date + dur)
        max_on = max(max_on, abs(p_on - ms_on))
        max_off = max(max_off, abs(p_off - ms_off))
        n_notes += 1
    pieces += 1

print(f"{pieces} pieces, {n_notes} notes")
print(f"max |onset diff|  = {max_on:.9f} ms")
print(f"max |offset diff| = {max_off:.9f} ms")
