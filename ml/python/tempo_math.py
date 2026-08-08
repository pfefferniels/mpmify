"""Exact Python port of meico's tempo rendering math (validated bit-exact between
meico Java and mpmify TS; this port mirrors mpmify/src/transformers/tempo/tempoCalculations.ts).

A tempo map is a list of instructions [date_ticks, bpm, transition_to|None, mean_tempo_at|None],
sorted by date, first at 0, last one constant (canonical form). beatLength fixed 0.25, ppq 720.
"""

import math

from java_libm import java_pow, java_log, JAVA_DOUBLE_MAX

PPQ = 720
BEAT_LENGTH = 0.25


def tempo_at(date, instr, end_date):
    d0, bpm, to, mta = instr
    if to is None or to == bpm:
        return bpm
    if date >= end_date:
        return to
    x = (date - d0) / (end_date - d0)
    exponent = java_log(0.5) / java_log(mta if mta else 0.5)
    return java_pow(x, exponent) * (to - bpm) + bpm


def _ms_const(date, instr):
    d0, bpm, _, _ = instr
    return 15000.0 * (date - d0) / (bpm * BEAT_LENGTH * PPQ)


def _ms_transition(date, instr, end_date):
    d0 = instr[0]
    n2 = 2 * math.floor((date - d0) / (PPQ / 4))
    if n2 == 0:
        n2 = 2
    n = n2 // 2
    x = (date - d0) / n2
    result_const = (date - d0) * 5000 / (n2 * BEAT_LENGTH * PPQ)
    s = 1 / instr[1] + 1 / tempo_at(date, instr, end_date)
    for k in range(1, n):
        s += 2 / tempo_at(d0 + 2 * k * x, instr, end_date)
    for k in range(1, n + 1):
        s += 4 / tempo_at(d0 + (2 * k - 1) * x, instr, end_date)
    return result_const * s


def segment_ms(date, instr, end_date):
    """Milliseconds elapsed from instr.date to `date` under this instruction."""
    if instr[2] is None or instr[2] == instr[1]:
        return _ms_const(date, instr)
    return _ms_transition(date, instr, end_date)


class TempoTimeline:
    """Piecewise tick->ms map for a canonical tempo map."""

    def __init__(self, tempo_map):
        self.instrs = tempo_map
        self.starts_ms = [0.0]
        for i in range(len(tempo_map) - 1):
            end = tempo_map[i + 1][0]
            self.starts_ms.append(self.starts_ms[-1] + segment_ms(end, tempo_map[i], end))

    def ms_at(self, ticks):
        # find containing segment (last instr with date <= ticks)
        i = 0
        for j in range(len(self.instrs)):
            if self.instrs[j][0] <= ticks:
                i = j
            else:
                break
        end = self.instrs[i + 1][0] if i + 1 < len(self.instrs) else JAVA_DOUBLE_MAX
        return self.starts_ms[i] + segment_ms(ticks, self.instrs[i], end)

    def bpm_at(self, ticks):
        i = 0
        for j in range(len(self.instrs)):
            if self.instrs[j][0] <= ticks:
                i = j
            else:
                break
        end = self.instrs[i + 1][0] if i + 1 < len(self.instrs) else JAVA_DOUBLE_MAX
        return tempo_at(ticks, self.instrs[i], end)
