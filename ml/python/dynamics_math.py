"""Exact Python port of meico's continuous-dynamics Bezier math (DynamicsData.java).

A dynamics map is a list [date_ticks, volume, transition_to|None, curvature|None,
protraction|None], sorted, first at 0, last constant (canonical form).
"""

from java_libm import JAVA_DOUBLE_MAX


def inner_control_points(curvature, protraction):
    if protraction == 0.0:
        return curvature, 1.0 - curvature
    ap = abs(protraction)
    x1 = curvature + ((ap + protraction) / (2.0 * protraction)
                      - (ap / protraction) * curvature) * protraction
    x2 = 1.0 - curvature + ((protraction - ap) / (2.0 * protraction)
                            + (ap / protraction) * curvature) * protraction
    return x1, x2


def _t_for_date(date, start, end, x1, x2):
    if date == start:
        return 0.0
    if date == end:
        return 1.0
    s = end - start
    d = date - start
    u = 3.0 * x1 - 3.0 * x2 + 1.0
    v = -6.0 * x1 + 3.0 * x2
    w = 3.0 * x1
    t = 0.5
    diff = (((u * t + v) * t + w) * t * s) - d
    tt = 0.25
    while abs(diff) >= 1.0:
        if diff > 0.0:
            t -= tt
        else:
            t += tt
        diff = (((u * t + v) * t + w) * t * s) - d
        tt *= 0.5
    return t


def dynamics_at(date, instr, end_date):
    d0, vol, to, curv, prot = (instr + [None, None, None])[:5]
    if to is None or to == vol or date < d0:
        return vol
    if date >= end_date:
        return to
    x1, x2 = inner_control_points(curv or 0.0, prot or 0.0)
    t = _t_for_date(date, d0, end_date, x1, x2)
    return ((3.0 - 2.0 * t) * t * t) * (to - vol) + vol


class DynamicsTimeline:
    def __init__(self, dyn_map):
        self.instrs = dyn_map

    def velocity_at(self, ticks):
        if not self.instrs:
            return 100.0
        i = 0
        for j in range(len(self.instrs)):
            if self.instrs[j][0] <= ticks:
                i = j
            else:
                break
        if ticks < self.instrs[0][0]:
            return 100.0
        end = self.instrs[i + 1][0] if i + 1 < len(self.instrs) else JAVA_DOUBLE_MAX
        return dynamics_at(ticks, self.instrs[i], end)
