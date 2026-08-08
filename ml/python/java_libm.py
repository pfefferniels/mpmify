"""Canonical import point for the bit-exact fdlibm port (Java Math.pow/Math.log parity).

The implementation currently lives in rubato_math.py (Team A was file-restricted);
this module is the stable import surface. Physically moving the code here is a
cosmetic follow-up — do it only when no other edit is in flight.

Bit-exactness is tied to the generating JVM: verified Math.pow == StrictMath.pow
(fdlibm) over 2e6 random args on Zulu 17.0.1 aarch64. Re-verify if data generation
moves to a different JVM/platform.
"""

from rubato_math import java_pow, java_log, JAVA_DOUBLE_MAX  # noqa: F401
