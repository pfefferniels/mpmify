/**
 * An exact re-implementation of `java.util.Random` (the 48-bit truncated LCG of
 * `java.util.Random`'s specification), in pure double arithmetic.
 *
 * Why this exists: the v4 generator supersedes `ml/java/SampleAndRender.java`, and the only
 * way to *prove* the port of the v3 sampling logic is faithful is to reproduce the Java
 * sampler's random stream bit-for-bit and diff the emitted JSONL. Every draw below is the
 * algorithm from the `java.util.Random` javadoc, which is normative (the class is specified,
 * not merely documented), so this is a specification port, not a reverse-engineering.
 *
 * Representation: the 48-bit seed is kept as two 24-bit halves (`hi`, `lo`), each an exact
 * non-negative double < 2^24. Every intermediate product below stays under 2^53 and is
 * therefore exact:
 *   seed*mul mod 2^48 = ((hi*mLo + lo*mHi) mod 2^24) * 2^24 + (lo*mLo mod 2^24) + carries
 * with mul = 0x5DEECE66D = 1502 * 2^24 + 15525485.
 */

const TWO24 = 16777216; // 2^24
const M_HI = 1502; //  0x5DEECE66D >>> 24
const M_LO = 15525485; //  0x5DEECE66D & 0xFFFFFF
const ADDEND = 11; // 0xB

export class JavaRandom {
  /** @param {bigint|number} seed the value a Java caller would pass to `new Random(seed)` */
  constructor(seed = 0n) {
    this.setSeed(seed);
  }

  /** `this.seed = (seed ^ 0x5DEECE66DL) & ((1L << 48) - 1)` */
  setSeed(seed) {
    const s = (BigInt.asUintN(64, BigInt(seed)) ^ 0x5deece66dn) & 0xffffffffffffn;
    this.hi = Number(s >> 24n);
    this.lo = Number(s & 0xffffffn);
  }

  /** `(int)(seed >>> (48 - bits))` after advancing the seed. `bits` in 1..32. */
  next(bits) {
    // advance: seed = (seed * 0x5DEECE66D + 0xB) & ((1 << 48) - 1)
    const t = this.lo * M_LO + ADDEND; // < 2^48 + 11, exact
    const carry = Math.floor(t / TWO24); // < 2^24
    const newLo = t - carry * TWO24; // < 2^24
    const newHi = (this.hi * M_LO + this.lo * M_HI + carry) % TWO24; // < 2^49 before %, exact
    this.hi = newHi;
    this.lo = newLo;

    // seed48 >>> (48 - bits)
    const shift = 48 - bits;
    let v;
    if (shift >= 24) v = Math.floor(newHi / Math.pow(2, shift - 24));
    else v = newHi * Math.pow(2, 24 - shift) + Math.floor(newLo / Math.pow(2, shift));
    return bits === 32 ? v | 0 : v; // (int) cast: only 32 bits can go negative
  }

  nextInt(bound) {
    if (bound === undefined) return this.next(32);
    if (!(bound > 0)) throw new RangeError('bound must be positive');
    const m = bound - 1;
    let r = this.next(31);
    if ((bound & m) === 0) {
      // power of two: (int)((bound * (long)r) >> 31) == r >>> (31 - log2(bound))
      return Math.floor(r / Math.pow(2, 31 - Math.round(Math.log2(bound))));
    }
    for (let u = r; ((u - (r = u % bound) + m) | 0) < 0; u = this.next(31));
    return r;
  }

  /** `(((long)next(26) << 27) + next(27)) * 0x1.0p-53` */
  nextDouble() {
    const hi = this.next(26);
    const lo = this.next(27);
    return (hi * 134217728 + lo) * Math.pow(2, -53); // 2^27 = 134217728
  }

  nextBoolean() {
    return this.next(1) !== 0;
  }
}

/** `Math.round(double)` → long, as Java defines it (half up, and NOT floor(x+0.5) at the
 *  0.49999999999999994 edge case Java 7 fixed). */
export function jround(x) {
  const f = Math.floor(x);
  return x - f >= 0.5 ? f + 1 : f;
}

/** `Math.rint(double)` — round half to even. */
export function jrint(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
