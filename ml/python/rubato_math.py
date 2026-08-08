"""Exact Python port of meico's rubato math (RubatoMap.java).

A rubato map is a list of instructions

    [date_ticks, frame_length_ticks, intensity, late_start, early_end, loop_flag01]

sorted by date. A rubato element is in force until the date of the *next* rubato element
(``endDate``, ``inf`` for the last one -- meico uses ``Double.MAX_VALUE``). Within that
scope it warps the tick dates of all map elements:

    local   = (date - startDate) mod frameLength
    newDate = date - local + (pow(local/frameLength, intensity) * (earlyEnd - lateStart)
                              + lateStart) * frameLength

With ``loop=False`` only the first frame ``[startDate, startDate + frameLength)`` is
affected; with ``loop=True`` the frame repeats until the next rubato element, i.e. a
trailing looped rubato warps everything up to the end of the piece. That is why the
v3 canonical form terminates every span with a neutral rubato element (``CANONICAL.md``
R6: ``intensity=1, lateStart=0, earlyEnd=1, loop=true``, frameLength inherited) whose
transformation is the identity (``(pow(l/f, 1) * (1-0) + 0) * f == l``, for *any* f).

Reference: meico ``RubatoMap.computeRubatoTransformation()`` and
``RubatoMap.renderRubatoToMap()`` (the latter is simulated in ``perf_chain.py``, because
its ``pendingDurations`` bookkeeping makes note offsets depend on neighbouring notes).

This module additionally hosts the *Java-exact elementary functions* ``java_pow`` and
``java_log`` (see the section below) because it is the leaf of the v3 port's import
graph; ``perf_chain`` imports them from here.
"""

import math
import struct

__all__ = ["RUB_DATE", "RUB_FRAME", "RUB_INTENSITY", "RUB_LATE_START", "RUB_EARLY_END",
           "RUB_LOOP", "warp", "RubatoTimeline", "java_pow", "java_log", "JAVA_DOUBLE_MAX"]

RUB_DATE = 0
RUB_FRAME = 1
RUB_INTENSITY = 2
RUB_LATE_START = 3
RUB_EARLY_END = 4
RUB_LOOP = 5

INF = float("inf")

#: Java ``Double.MAX_VALUE``.  meico uses this -- *not* infinity -- as the end date of the
#: last instruction of a map (``RubatoMap.getEndDate()``:318, ``TempoMap.getEndDate()``:279).
#: For rubato the distinction is invisible (the value is only ever compared against), but
#: for tempo ``endDate`` is a *divisor* in ``getTempoAt()``, so a final instruction that
#: carries a dangling ``transition.to`` evaluates ``pow((date-start)/(MAX-start), e)``
#: ~ 1e-317, not ``pow(0.0, e)`` == 0.  Using ``inf`` here was a latent divergence.
JAVA_DOUBLE_MAX = 1.7976931348623157e308


# =====================================================================================
# Java-exact elementary functions
# =====================================================================================
#
# WHY THIS EXISTS.  meico is Java and uses ``Math.pow`` / ``Math.log``.  On the JDK used
# for data generation (Zulu 17, aarch64) ``Math.pow`` and ``Math.log`` are bit-identical
# to ``StrictMath`` -- i.e. to Sun's fdlibm (verified over 2e6 random arguments: 0
# differences).  CPython's ``math.pow`` / ``math.log`` call the platform libm, which on
# macOS is correctly rounded and therefore differs from fdlibm by 1 ulp for roughly 10%
# of arguments (measured: 19635/200000 for pow, 12200/200000 for log).
#
# Those 1-ulp differences propagate into meico's Simpson sums and rubato warps and made
# ~0.6% of the rendered millisecond values differ by 1 ulp (1.8e-12 ms).  The project's
# standard of proof is *bit-exact* reproduction, so the two functions are ported here
# straight from fdlibm's ``e_pow.c`` / ``e_log.c``, including the high/low word games.
#
# VERIFIED bit-exact against Java ``Math.pow``/``Math.log``, by raw 64-bit pattern, on
#   * 200000 random arguments spanning the value ranges that occur in this pipeline, and
#   * a 650-case edge grid (+-0, +-1, +-inf, NaN, subnormals, +-2^+-1074, integral and
#     non-integral exponents, |y| > 2^31 and > 2^64, the overflow/underflow thresholds).
# The edge grid is what caught the ``1.0/0.0`` crash fixed in ``_recip`` below, the
# subnormal misrounding fixed in ``_scalbn`` and the NaN-payload loss fixed in ``java_log``;
# a random sweep alone covered none of the three.  Latest sweep: 1 000 650 arguments,
# 0 mismatches, 0 crashes (the platform libm misses 148 396 of the same pow values and
# 37 610 of the log values).  ``python3 validate_v3.py --selftest`` re-runs the corner
# grid without Java; the full sweep needs a Java reference dump of
# ``(x, y, Math.pow(x,y), Math.log(x))`` raw bit patterns.
#
# Bit-exactness is tied to the generating JVM: on Zulu 17 aarch64 ``Math.pow``/``Math.log``
# are identical to ``StrictMath`` (re-verified this session: 0 differences over 2 000 000
# arguments spanning [0,2], subnormal and 2**+-700 magnitudes, and random bit patterns).
# Re-run that check before trusting the port on another JVM or architecture.

def _bits(x):
    return struct.unpack('<Q', struct.pack('<d', x))[0]


def _dbl(b):
    return struct.unpack('<d', struct.pack('<Q', b & 0xFFFFFFFFFFFFFFFF))[0]


def _hi(x):
    """C ``__HI(x)`` assigned to an ``int`` -> signed 32-bit high word"""
    u = (_bits(x) >> 32) & 0xFFFFFFFF
    return u - 0x100000000 if u >= 0x80000000 else u


def _lo(x):
    """C ``__LO(x)`` assigned to an ``unsigned`` -> unsigned 32-bit low word"""
    return _bits(x) & 0xFFFFFFFF


def _set_hi(x, h):
    return _dbl((_bits(x) & 0xFFFFFFFF) | ((h & 0xFFFFFFFF) << 32))


def _set_lo(x, l):
    return _dbl((_bits(x) & 0xFFFFFFFF00000000) | (l & 0xFFFFFFFF))


def _i32(v):
    v &= 0xFFFFFFFF
    return v - 0x100000000 if v >= 0x80000000 else v


def _scalbn(x, n):
    """fdlibm ``scalbn`` == Java ``Math.scalb`` -- x * 2**n, one rounding.

    ``math.ldexp`` cannot be used for this: on macOS (CPython -> platform libm) it is
    NOT correctly rounded when the result is subnormal.  Measured: for 39 of 20000
    Java-generated arguments whose ``Math.pow`` result is subnormal, ``math.ldexp``
    returned a value 1 ulp away from both Java and the exactly-rounded value (verified
    with ``fractions.Fraction``); e.g. ``ldexp(0x3fec7361894cfdb7, -1025)`` yields
    ``0x1c7361894cfdc`` where the correct answer is ``0x1c7361894cfdb``.  fdlibm scales
    the exponent field (exact) and then performs a single multiplication by 2**-54, which
    rounds once and matches Java.  Only the branches ``java_pow`` can reach are needed,
    but the full guard set is kept for safety.
    """
    hx = _hi(x)
    k = (hx & 0x7FF00000) >> 20
    if k == 0:                                          # 0 or subnormal x
        if (_lo(x) | (hx & 0x7FFFFFFF)) == 0:
            return x                                    # +-0
        x = x * _two54
        hx = _hi(x)
        k = ((hx & 0x7FF00000) >> 20) - 54
        if n < -50000:
            return _tinyv * x                           # underflow
    if k == 0x7FF:
        return x + x                                    # NaN or Inf
    k += n
    if k > 0x7FE:
        return math.copysign(_hugev, x) * _hugev        # overflow
    if k > 0:                                           # normal result
        return _set_hi(x, (hx & 0x800FFFFF) | (k << 20))
    if k <= -54:
        if n > 50000:
            return math.copysign(_hugev, x) * _hugev    # overflow
        return math.copysign(_tinyv, x) * _tinyv        # underflow
    k += 54                                             # subnormal result
    return _set_hi(x, (hx & 0x800FFFFF) | (k << 20)) * _twom54


def _recip(z):
    """C/Java ``1.0 / z``.

    Python raises ``ZeroDivisionError`` on a zero divisor where IEEE-754 (and therefore
    C's fdlibm and Java) return a signed infinity.  ``java_pow`` divides by ``|x|`` and by
    ``x`` on its ``x == +-0`` / ``|y| == 1`` shortcuts, so without this helper
    ``java_pow(+-0.0, y<0)`` crashed instead of returning ``+-inf`` (``java_log`` has no
    division and was never affected).  Unreachable from the v3 canonical form -- the tempo
    exponent ``log(0.5)/log(mta) > 0`` and the rubato intensity are both positive, and the
    bases are ratios in ``[0, 1]`` -- but reachable from model-generated maps.
    """
    if z == 0.0:
        return math.copysign(INF, z)                # 1/+0 = +inf, 1/-0 = -inf
    return 1.0 / z


# ---- fdlibm e_log.c constants
_ln2_hi = _dbl(0x3FE62E42FEE00000)
_ln2_lo = _dbl(0x3DEA39EF35793C76)
_two54 = _dbl(0x4350000000000000)
_twom54 = _dbl(0x3C90000000000000)                  # 2**-54, for _scalbn
_Lg1 = _dbl(0x3FE5555555555593)
_Lg2 = _dbl(0x3FD999999997FA04)
_Lg3 = _dbl(0x3FD2492494229359)
_Lg4 = _dbl(0x3FCC71C51D8E78AF)
_Lg5 = _dbl(0x3FC7466496CB03DE)
_Lg6 = _dbl(0x3FC39A09D078C69F)
_Lg7 = _dbl(0x3FC2F112DF3E5244)


def java_log(x):
    """fdlibm ``__ieee754_log`` == Java ``StrictMath.log`` == Java ``Math.log``."""
    hx = _hi(x)
    lx = _lo(x)
    k = 0
    if hx < 0x00100000:                             # x < 2**-1022
        if ((hx & 0x7FFFFFFF) | lx) == 0:
            return float('-inf')                    # log(+-0) = -inf
        if hx < 0:                                  # fdlibm: return (x-x)/zero
            if x != x:                              # ... which for a NaN input propagates
                return _dbl(_bits(x) | 0x0008000000000000)   # that NaN, quieted
            return float('nan')                     # log(-#) = NaN (canonical, as Java)
        k -= 54
        x = x * _two54                              # subnormal, scale up
        hx = _hi(x)
    if hx >= 0x7FF00000:
        return x + x
    k += (hx >> 20) - 1023
    hx &= 0x000FFFFF
    i = (hx + 0x95F64) & 0x100000
    x = _set_hi(x, hx | (i ^ 0x3FF00000))           # normalize x or x/2
    k += (i >> 20)
    f = x - 1.0
    if (0x000FFFFF & (2 + hx)) < 3:                 # |f| < 2**-20
        if f == 0.0:
            if k == 0:
                return 0.0
            dk = float(k)
            return dk * _ln2_hi + dk * _ln2_lo
        R = f * f * (0.5 - 0.33333333333333333 * f)
        if k == 0:
            return f - R
        dk = float(k)
        return dk * _ln2_hi - ((R - dk * _ln2_lo) - f)
    s = f / (2.0 + f)
    dk = float(k)
    z = s * s
    i = hx - 0x6147A
    w = z * z
    j = 0x6B851 - hx
    t1 = w * (_Lg2 + w * (_Lg4 + w * _Lg6))
    t2 = z * (_Lg1 + w * (_Lg3 + w * (_Lg5 + w * _Lg7)))
    i |= j
    R = t2 + t1
    if i > 0:
        hfsq = 0.5 * f * f
        if k == 0:
            return f - (hfsq - s * (hfsq + R))
        return dk * _ln2_hi - ((hfsq - (s * (hfsq + R) + dk * _ln2_lo)) - f)
    if k == 0:
        return f - s * (f - R)
    return dk * _ln2_hi - ((s * (f - R) - dk * _ln2_lo) - f)


# ---- fdlibm e_pow.c constants
_bp = (1.0, 1.5)
_dp_h = (0.0, _dbl(0x3FE2B80340000000))
_dp_l = (0.0, _dbl(0x3E4CFDEB43CFD006))
_two53 = 9007199254740992.0
_hugev = 1.0e300
_tinyv = 1.0e-300
_L1 = _dbl(0x3FE3333333333303)
_L2 = _dbl(0x3FDB6DB6DB6FABFF)
_L3 = _dbl(0x3FD55555518F264D)
_L4 = _dbl(0x3FD17460A91D4101)
_L5 = _dbl(0x3FCD864A93C9DB65)
_L6 = _dbl(0x3FCA7E284A454EEF)
_P1 = _dbl(0x3FC555555555553E)
_P2 = _dbl(0xBF66C16C16BEBD93)
_P3 = _dbl(0x3F11566AAF25DE2C)
_P4 = _dbl(0xBEBBBD41C5D26BF1)
_P5 = _dbl(0x3E66376972BEA4D0)
_lg2 = _dbl(0x3FE62E42FEFA39EF)
_lg2_h = _dbl(0x3FE62E4300000000)
_lg2_l = _dbl(0xBE205C610CA86C39)
_ovt = 8.0085662595372944372e-17
_cp = _dbl(0x3FEEC709DC3A03FD)
_cp_h = _dbl(0x3FEEC709E0000000)
_cp_l = _dbl(0xBE3E2FE0145B01F5)
_ivln2 = _dbl(0x3FF71547652B82FE)
_ivln2_h = _dbl(0x3FF7154760000000)
_ivln2_l = _dbl(0x3E54AE0BF85DDF44)


def java_pow(x, y):
    """fdlibm ``__ieee754_pow`` == Java ``StrictMath.pow`` == Java ``Math.pow``."""
    hx = _hi(x)
    lx = _lo(x)
    hy = _hi(y)
    ly = _lo(y)
    ix = hx & 0x7FFFFFFF
    iy = hy & 0x7FFFFFFF

    if (iy | ly) == 0:                                          # y == 0 -> 1
        return 1.0
    if (ix > 0x7FF00000 or (ix == 0x7FF00000 and lx != 0)
            or iy > 0x7FF00000 or (iy == 0x7FF00000 and ly != 0)):
        return x + y                                            # NaN

    yisint = 0                                                  # 1 = odd int, 2 = even int
    if hx < 0:
        if iy >= 0x43400000:
            yisint = 2
        elif iy >= 0x3FF00000:
            k = (iy >> 20) - 0x3FF
            if k > 20:
                j = ly >> (52 - k)
                if ((j << (52 - k)) & 0xFFFFFFFF) == ly:
                    yisint = 2 - (j & 1)
            elif ly == 0:
                j = iy >> (20 - k)
                if (j << (20 - k)) == iy:
                    yisint = 2 - (j & 1)

    if ly == 0:
        if iy == 0x7FF00000:                                    # y is +-inf
            if ((ix - 0x3FF00000) | lx) == 0:
                return y - y
            elif ix >= 0x3FF00000:
                return y if hy >= 0 else 0.0
            else:
                return -y if hy < 0 else 0.0
        if iy == 0x3FF00000:                                    # y is +-1
            return _recip(x) if hy < 0 else x
        if hy == 0x40000000:                                    # y is 2
            return x * x
        if hy == 0x3FE00000:                                    # y is 0.5
            if hx >= 0:
                return math.sqrt(x)

    ax = abs(x)
    if lx == 0:
        if ix == 0x7FF00000 or ix == 0 or ix == 0x3FF00000:     # x is +-0, +-inf, +-1
            z = ax
            if hy < 0:
                z = _recip(z)
            if hx < 0:
                if ((ix - 0x3FF00000) | yisint) == 0:
                    return float('nan')
                elif yisint == 1:
                    z = -z
            return z

    n = (_i32(hx) >> 31) + 1
    if (n | yisint) == 0:
        return float('nan')                                     # (x<0)**(non-int)

    s = 1.0
    if (n | (yisint - 1)) == 0:
        s = -1.0                                                # (-ve)**(odd int)

    if iy > 0x41E00000:                                         # |y| > 2**31
        if iy > 0x43F00000:                                     # |y| > 2**64
            if ix <= 0x3FEFFFFF:
                return _hugev * _hugev if hy < 0 else _tinyv * _tinyv
            if ix >= 0x3FF00000:
                return _hugev * _hugev if hy > 0 else _tinyv * _tinyv
        if ix < 0x3FEFFFFF:
            return s * _hugev * _hugev if hy < 0 else s * _tinyv * _tinyv
        if ix > 0x3FF00000:
            return s * _hugev * _hugev if hy > 0 else s * _tinyv * _tinyv
        t = ax - 1.0
        w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25))
        u = _ivln2_h * t
        v = t * _ivln2_l - w * _ivln2
        t1 = _set_lo(u + v, 0)
        t2 = v - (t1 - u)
    else:
        n = 0
        if ix < 0x00100000:                                     # subnormal x
            ax = ax * _two53
            n -= 53
            ix = _hi(ax)
        n += (ix >> 20) - 0x3FF
        j = ix & 0x000FFFFF
        ix = j | 0x3FF00000                                     # normalize ix
        if j <= 0x3988E:
            k = 0                                               # |x| < sqrt(3/2)
        elif j < 0xBB67A:
            k = 1                                               # |x| < sqrt(3)
        else:
            k = 0
            n += 1
            ix -= 0x00100000
        ax = _set_hi(ax, ix)

        u = ax - _bp[k]
        v = 1.0 / (ax + _bp[k])
        ss = u * v
        s_h = _set_lo(ss, 0)
        t_h = _set_hi(0.0, ((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18))
        t_l = ax - (t_h - _bp[k])
        s_l = v * ((u - s_h * t_h) - s_h * t_l)
        s2 = ss * ss
        r = s2 * s2 * (_L1 + s2 * (_L2 + s2 * (_L3 + s2 * (_L4 + s2 * (_L5 + s2 * _L6)))))
        r += s_l * (s_h + ss)
        s2 = s_h * s_h
        t_h = _set_lo(3.0 + s2 + r, 0)
        t_l = r - ((t_h - 3.0) - s2)
        u = s_h * t_h
        v = s_l * t_h + t_l * ss
        p_h = _set_lo(u + v, 0)
        p_l = v - (p_h - u)
        z_h = _cp_h * p_h
        z_l = _cp_l * p_h + p_l * _cp + _dp_l[k]
        t = float(n)
        t1 = _set_lo(((z_h + z_l) + _dp_h[k]) + t, 0)
        t2 = z_l - (((t1 - t) - _dp_h[k]) - z_h)

    y1 = _set_lo(y, 0)                                          # split y into y1 + y2
    p_l = (y - y1) * t1 + y * t2
    p_h = y1 * t1
    z = p_l + p_h
    j = _hi(z)
    i = _lo(z)
    if j >= 0x40900000:                                         # z >= 1024
        if ((j - 0x40900000) | i) != 0:
            return s * _hugev * _hugev
        elif p_l + _ovt > z - p_h:
            return s * _hugev * _hugev
    elif (j & 0x7FFFFFFF) >= 0x4090CC00:                        # z <= -1075
        if (_i32(j - 0xC090CC00) | i) != 0:
            return s * _tinyv * _tinyv
        elif p_l <= z - p_h:
            return s * _tinyv * _tinyv

    # compute 2**(p_h + p_l)
    i = j & 0x7FFFFFFF
    k = (i >> 20) - 0x3FF
    n = 0
    if i > 0x3FE00000:                                          # |z| > 0.5 -> n = [z+0.5]
        n = _i32(j + (0x00100000 >> (k + 1)))
        k = ((n & 0x7FFFFFFF) >> 20) - 0x3FF
        t = _set_hi(0.0, _i32(n & ~(_i32(0x000FFFFF) >> k)))
        n = ((n & 0x000FFFFF) | 0x00100000) >> (20 - k)
        if j < 0:
            n = -n
        p_h -= t
    t = _set_lo(p_l + p_h, 0)
    u = t * _lg2_h
    v = (p_l - (t - p_h)) * _lg2 + t * _lg2_l
    z = u + v
    w = v - (z - u)
    t = z * z
    t1 = z - t * (_P1 + t * (_P2 + t * (_P3 + t * (_P4 + t * _P5))))
    r = (z * t1) / (t1 - 2.0) - (w + z * w)
    z = 1.0 - (r - z)
    j = _i32(_hi(z) + _i32(n << 20))
    if (j >> 20) <= 0:
        z = _scalbn(z, n)                                       # subnormal output
    else:
        z = _set_hi(z, j)
    return s * z


# =====================================================================================
# rubato
# =====================================================================================

def warp(date, instr):
    """meico ``RubatoMap.computeRubatoTransformation(date, rubatoData)``.

    No scope check is performed here -- the caller decides which instruction applies
    (see ``RubatoTimeline.instr_index_for_date`` / ``perf_chain.PerfChain``).
    """
    start = instr[RUB_DATE]
    frame = instr[RUB_FRAME]
    intensity = instr[RUB_INTENSITY]
    late_start = instr[RUB_LATE_START]
    early_end = instr[RUB_EARLY_END]
    # Java's % on doubles is the truncated remainder; date >= start here, so fmod == %
    local = math.fmod(date - start, frame)
    d = (java_pow(local / frame, intensity) * (early_end - late_start) + late_start) * frame
    return date + d - local


class RubatoTimeline:
    """Scope lookup for a rubato map (list of instructions, sorted by date)."""

    def __init__(self, rubato_map):
        self.instrs = list(rubato_map or [])
        for i in range(1, len(self.instrs)):                    # meico sorts its maps on
            if self.instrs[i][RUB_DATE] < self.instrs[i - 1][RUB_DATE]:   # parse/insert; an
                raise ValueError(                               # unsorted list would render
                    "rubato map is not sorted by date: instruction %d (date %s) precedes "
                    "instruction %d (date %s)" % (i, self.instrs[i][RUB_DATE], i - 1,
                                                  self.instrs[i - 1][RUB_DATE]))
        self.end_dates = []
        for i in range(len(self.instrs)):
            # meico RubatoMap.getEndDate(): the next element's date, else Double.MAX_VALUE
            self.end_dates.append(self.instrs[i + 1][RUB_DATE] if i + 1 < len(self.instrs)
                                  else JAVA_DOUBLE_MAX)

    def __len__(self):
        return len(self.instrs)

    def end_date(self, i):
        return self.end_dates[i]

    def in_scope(self, i, date):
        """True if `date` falls in the scope of instruction i, mirroring the break
        conditions of meico's renderRubatoToMap()."""
        instr = self.instrs[i]
        if date < instr[RUB_DATE]:
            return False
        if date >= self.end_dates[i]:
            return False
        if not instr[RUB_LOOP] and date >= instr[RUB_DATE] + instr[RUB_FRAME]:
            return False
        return True

    def instr_index_for_date(self, date):
        """Index of the rubato instruction that warps `date`, or None.

        Valid for maps whose elements are sorted and whose scopes do not overlap
        (guaranteed by construction: each element's scope ends at the next element's date).
        """
        lo = None
        for i, instr in enumerate(self.instrs):
            if instr[RUB_DATE] <= date:
                lo = i
            else:
                break
        if lo is None:
            return None
        return lo if self.in_scope(lo, date) else None

    def warp_date(self, date):
        """Warp a single date (identity if no instruction is in scope)."""
        i = self.instr_index_for_date(date)
        return date if i is None else warp(date, self.instrs[i])
