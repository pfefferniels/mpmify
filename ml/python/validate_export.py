"""End-to-end export validation: model-space maps -> MPM file -> meico -> augmented MSM.

For every pilot piece this
  1. reads the ground-truth maps from the generator's JSONL,
  2. runs them through `dsl_to_mpm.maps_to_mpm()` and writes a .mpm file,
  3. renders that .mpm onto the generator-written .msm with `java RenderMpm` (meico),
  4. parses the augmented MSM and compares every note's milliseconds.date,
     milliseconds.date.end and velocity against the JSONL values.

Everything must be bit-exact (0.0 diff): the JSONL values came out of meico's own
rendering of the in-memory MPM object graph, so any nonzero diff means our XML does not
mean the same thing to meico's parser.

Additionally the written MPM is byte-compared against the generator's own .mpm to prove
the emitted vocabulary/serialization is identical, not merely equivalent -- and that
comparison is part of the exit code, not decoration.

Modes
-----
  (no args) / <pieces.jsonl> [debug_dir] [work_dir]
        pilot validation as described above.
  --stress [n_trials] [seed]
        random maps that deliberately leave canonical form -- non-beat-aligned dates,
        omitted meanTempoAt/curvature/protraction, dangling final transitions, ROWS IN
        THE WRONG ORDER, out-of-range curvature/protraction/meanTempoAt, duplicate dates
        -- checked against `tempo_math`/`dynamics_math` (fed the canonicalized rows) as
        an independent oracle. All trials render in ONE JVM via `RenderMpm --batch`.
  --selftest
        adversarial controls: every guard in dsl_to_mpm is shown to fire, the two silent
        divergences it fixes (unsorted rows, unclamped curvature/protraction) are
        reproduced against meico, and negative controls prove this harness can fail.
  --formats
        `dsl_to_mpm._jd` vs this JDK's `Double.toString` over ~146k values.

Paths can also come from EXPORT_JSONL / EXPORT_DEBUG / EXPORT_WORK (needed in --stress
mode, whose positional arguments are n_trials and seed). Defaults regenerate a 3-piece
pilot (nice -n 15) if the inputs are missing.

Precision note (measured, scratchpad probe): the pilot mode requires EXACT 0.0, and gets
it -- the generator's canonical value grid (2-decimal meanTempoAt, beat-aligned dates)
happens to evaluate identically in both runtimes. The stress mode explores arbitrary
values, where the JVM's `Math.pow` / `Math.log` and CPython's libm disagree by 1 ULP:
over the 7,682 distinct (x, meanTempoAt) pairs the 40 stress maps actually evaluate,
`Math.log(0.5)/Math.log(mta)` differs for 434 and `Math.pow(x, exponent)` for 935, always
by 1 ULP (rel ~1.6e-16). Accumulated over ~30 instructions that shows up as <= 1e-12 ms
in the rendered onsets. It is a property of the two runtimes, not of the export bridge or
of the ports, so the stress mode accepts <= TOL (1e-9 ms, the project's stated tolerance)
and prints the actual residual, which is 0.0 for most categories.

Port caveat found while building this: meico ends the last instruction of a map at
`Double.MAX_VALUE`, not at infinity. tempo_math/dynamics_math use float("inf"), which is
fine for the canonical form they document but makes DynamicsData's Bezier bisection spin
forever on a dangling final transition. `JavaDynamicsTimeline`/`JavaTempoTimeline` below
restore the finite sentinel; with it, both meico and the ports agree that a dangling
transition is inert (renders as the constant start value).
"""

import json
import os
import random
import subprocess
import sys
import xml.etree.ElementTree as ET

from dsl_to_mpm import (MpmExportError, canonicalize_maps, maps_to_mpm, _jd, _num)
from tempo_math import TempoTimeline, segment_ms
from dynamics_math import DynamicsTimeline, dynamics_at

HERE = os.path.dirname(os.path.abspath(__file__))
JAVA_DIR = os.path.join(HERE, "..", "java")
MEICO = "/Users/nielspfeffer/Projects/meico"
CP = (f"{os.path.abspath(JAVA_DIR)}/out:{MEICO}/out/production/meico:{MEICO}/externals/*")

MODE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].startswith("--") else None
ARGS = [] if MODE else sys.argv[1:]
# positional in normal mode; env overrides work in both modes (--stress takes n/seed
# positionally, and other agents share /tmp, so the defaults must be overridable)
JSONL = ARGS[0] if len(ARGS) > 0 else os.environ.get("EXPORT_JSONL", "/tmp/exp_pilot.jsonl")
DEBUG_DIR = ARGS[1] if len(ARGS) > 1 else os.environ.get("EXPORT_DEBUG", "/tmp/exp_debug")
WORK_DIR = ARGS[2] if len(ARGS) > 2 else os.environ.get("EXPORT_WORK", "/tmp/exp_export")
N_PILOT = 3
SEED = "5555"
# meico's parse-time clamp warnings; if any of these appear we emitted a value meico had
# to repair, i.e. the XML no longer means what the Python oracle computed (same class of
# silent divergence as the mandatory-beatLength drop).
CLAMP_WARNINGS = ("Invalid curvature value", "Invalid protraction value")
# stress-mode tolerance: JVM vs CPython transcendentals differ by 1 ULP (see docstring).
# The pilot mode, on canonical values, still requires exact 0.0.
TOL = 1e-9


def run(cmd):
    return subprocess.run(["nice", "-n", "15"] + cmd, cwd=os.path.abspath(JAVA_DIR),
                          capture_output=True, text=True)


def run_batch(jobs, tag="batch"):
    """jobs: list of (msm, mpm, out) absolute paths -> one JVM for all of them."""
    manifest = os.path.join(WORK_DIR, f"{tag}_manifest.tsv")
    with open(manifest, "w") as fh:
        for msm, mpm, out in jobs:
            fh.write(f"{os.path.abspath(msm)}\t{os.path.abspath(mpm)}\t{os.path.abspath(out)}\n")
    return run(["java", "-cp", CP, "RenderMpm", "--batch", os.path.abspath(manifest)])


def ensure_pilot():
    if os.path.exists(JSONL) and os.path.exists(os.path.join(DEBUG_DIR, "piece0.msm")):
        return
    print(f"# regenerating {N_PILOT}-piece pilot -> {JSONL}, {DEBUG_DIR}")
    r = run(["java", "-cp", CP, "SampleAndRender", JSONL, str(N_PILOT), SEED,
             "tempo,dynamics", DEBUG_DIR])
    if r.returncode != 0:
        sys.exit("SampleAndRender failed:\n" + r.stdout + r.stderr)


def parse_notes(path):
    """Augmented-MSM notes in document order -> (ms_on, ms_off, velocity|None).

    Raises if a note carries no milliseconds.* attributes: that is exactly what a
    silently dropped tempoMap looks like (e.g. a `tempo` without `beatLength`), and it
    must never be mistaken for a successful render."""
    root = ET.parse(path).getroot()
    out = []
    for part in root.findall("part"):
        score = part.find("dated/score")
        if score is None:
            continue
        for i, n in enumerate(score.findall("note")):
            on, off = n.get("milliseconds.date"), n.get("milliseconds.date.end")
            if on is None or off is None:
                raise ValueError(
                    f"{os.path.basename(path)}: note {i} has no milliseconds.* attributes "
                    f"(attrs: {','.join(sorted(n.attrib))}) -- the performance was not "
                    "rendered onto it (dropped map?)")
            vel = n.get("velocity")
            out.append((float(on), float(off), None if vel is None else float(vel)))
    return out


def parse_score(path):
    """Raw-MSM notes in document order -> (date_ticks, duration_ticks)."""
    root = ET.parse(path).getroot()
    out = []
    for part in root.findall("part"):
        score = part.find("dated/score")
        if score is None:
            continue
        for n in score.findall("note"):
            out.append((float(n.get("date")), float(n.get("duration"))))
    return out


# ---------------------------------------------------------------- oracle

# meico ends the LAST instruction of a map at Double.MAX_VALUE (TempoMap.getEndDate /
# DynamicsMap.getEndDate), not at infinity. tempo_math/dynamics_math use float("inf"),
# which is equivalent for the canonical form the ports document (last instruction
# constant, so the end date is never used) but not for a dangling final transition:
# DynamicsData's Bezier bisection over an infinite span never satisfies its
# |diff| < 1 tick exit condition and spins forever. Mirroring Java's finite sentinel
# makes the oracle faithful for the dangling case too (both then converge to the
# start value, i.e. the transition is inert).
DOUBLE_MAX = 1.7976931348623157e308


def _seg_index(instrs, ticks):
    i = 0
    for j in range(len(instrs)):
        if instrs[j][0] <= ticks:
            i = j
        else:
            break
    return i


class JavaTempoTimeline(TempoTimeline):
    def ms_at(self, ticks):
        i = _seg_index(self.instrs, ticks)
        end = self.instrs[i + 1][0] if i + 1 < len(self.instrs) else DOUBLE_MAX
        return self.starts_ms[i] + segment_ms(ticks, self.instrs[i], end)


class JavaDynamicsTimeline(DynamicsTimeline):
    def velocity_at(self, ticks):
        if not self.instrs or ticks < self.instrs[0][0]:
            return 100.0
        i = _seg_index(self.instrs, ticks)
        end = self.instrs[i + 1][0] if i + 1 < len(self.instrs) else DOUBLE_MAX
        return dynamics_at(ticks, self.instrs[i], end)


def compare(out_msm, score, tempo, dyn, canonicalize=True):
    """max |diff| between meico's render of `out_msm` and the Python oracle for these
    maps -> (d_on, d_off, d_vel, n_notes). `canonicalize=False` reproduces the pre-fix
    behaviour: oracle on the RAW rows, i.e. what an evaluator would have computed."""
    if canonicalize:
        tempo, dyn = canonicalize_maps(tempo, dyn)
    tl, dl = JavaTempoTimeline(tempo), JavaDynamicsTimeline(dyn)
    rendered = parse_notes(out_msm)
    if len(rendered) != len(score):
        raise ValueError(f"{os.path.basename(out_msm)}: note count {len(rendered)} != "
                         f"{len(score)} in the score")
    d = [0.0, 0.0, 0.0]
    for (ms_on, ms_off, vel), (date, dur) in zip(rendered, score):
        d[0] = max(d[0], abs(ms_on - tl.ms_at(date)))
        d[1] = max(d[1], abs(ms_off - tl.ms_at(date + dur)))
        if dyn:
            if vel is None:
                raise ValueError(f"{os.path.basename(out_msm)}: dynamicsMap present but "
                                 "the rendered note carries no velocity attribute")
            d[2] = max(d[2], abs(vel - dl.velocity_at(date)))
    return d[0], d[1], d[2], len(rendered)


# ---------------------------------------------------------------- stress mode

CATEGORIES = ["canonical (last constant)", "dangling final transition",
              "rows in reverse order", "out-of-range curv/prot/mta", "duplicate dates"]


def _sample_maps(rng, total_ticks, ppq, category):
    """Random maps that deliberately leave the generator's canonical form: dates need not
    be beat-aligned, meanTempoAt / curvature / protraction may be omitted, the final
    instruction may keep a (dangling) transition, rows may arrive unsorted or with
    out-of-range values or duplicate dates."""
    def dates():
        ds, t = [0.0], 0.0
        while True:
            t += rng.choice([ppq, 2 * ppq, 3 * ppq, ppq / 2, ppq / 3, 1234.5, 45.0])
            if t >= total_ticks:
                break
            ds.append(round(t, 4))
        return ds

    oor = CATEGORIES[category] == "out-of-range curv/prot/mta"
    tempo, dyn = [], []
    for d in dates():
        bpm = round(rng.uniform(30, 240), 1)
        last = None
        if rng.random() < 0.5:
            to = round(rng.uniform(30, 240), 1)
            if to != bpm:
                mta = None if rng.random() < 0.2 else round(rng.uniform(0.05, 0.95), 3)
                if oor and rng.random() < 0.4:          # meico collapses these
                    mta = rng.choice([0.0, 1.0, -0.5, 1.7])
                last = [d, bpm, to, mta]
        tempo.append(last or [d, bpm, None, None])
    for d in dates():
        vol = round(rng.uniform(1, 127), 1)
        row = [d, vol, None, None, None]
        if rng.random() < 0.5:
            to = round(rng.uniform(1, 127), 1)
            if to != vol:
                lo, hi = (-0.7, 1.7) if oor else (0.0, 1.0)
                lo2, hi2 = (-2.0, 2.0) if oor else (-1.0, 1.0)
                row = [d, vol, to,
                       None if rng.random() < 0.2 else round(rng.uniform(lo, hi), 3),
                       None if rng.random() < 0.2 else round(rng.uniform(lo2, hi2), 3)]
        dyn.append(row)

    if CATEGORIES[category] != "dangling final transition":   # canonical: last constant
        tempo[-1][2] = tempo[-1][3] = None
        dyn[-1][2] = dyn[-1][3] = dyn[-1][4] = None
    if CATEGORIES[category] == "duplicate dates":
        # a second instruction at an existing date; meico keeps document order (stable
        # insertion sort in GenericMap), so the LAST row at that date wins
        i = rng.randrange(len(tempo))
        tempo.insert(i + 1, [tempo[i][0], round(rng.uniform(30, 240), 1), None, None])
        j = rng.randrange(len(dyn))
        dyn.insert(j + 1, [dyn[j][0], round(rng.uniform(1, 127), 1), None, None, None])
    if CATEGORIES[category] == "rows in reverse order":
        tempo.reverse()
        dyn.reverse()
    return tempo, dyn


def stress(n_trials, seed):
    if n_trials < 1:
        sys.exit("--stress needs at least 1 trial")
    ensure_pilot()
    os.makedirs(WORK_DIR, exist_ok=True)
    rng = random.Random(seed)
    msms = [os.path.join(DEBUG_DIR, f"piece{i}.msm") for i in range(3)]
    msms = [m for m in msms if os.path.exists(m)]
    if not msms:
        sys.exit(f"no pilot .msm files in {DEBUG_DIR}")
    scores = {m: parse_score(m) for m in msms}

    trials, jobs = [], []
    for k in range(n_trials):
        category = k % len(CATEGORIES)
        msm = msms[k % len(msms)]
        total = max(d + dur for d, dur in scores[msm])
        tempo, dyn = _sample_maps(rng, total, 720, category)
        mpm_path = os.path.join(WORK_DIR, f"stress{k}.mpm")
        with open(mpm_path, "w") as fh:
            fh.write(maps_to_mpm(tempo, dyn, ppq=720, name="perf"))
        out_msm = os.path.join(WORK_DIR, f"stress{k}_augmented.msm")
        trials.append((category, msm, tempo, dyn, out_msm))
        jobs.append((msm, mpm_path, out_msm))

    r = run_batch(jobs, tag="stress")
    if r.returncode != 0:
        sys.exit(f"RenderMpm --batch exit {r.returncode}\n{r.stdout}{r.stderr}")
    warned = [w for w in CLAMP_WARNINGS if w in r.stderr]
    if warned:
        sys.exit(f"meico had to repair values we emitted: {warned}\n{r.stderr[:800]}")

    worst = {c: [0.0, 0.0, 0.0, 0, 0] for c in range(len(CATEGORIES))}
    for category, msm, tempo, dyn, out_msm in trials:
        d_on, d_off, d_vel, n = compare(out_msm, scores[msm], tempo, dyn)
        w = worst[category]
        w[0], w[1], w[2] = max(w[0], d_on), max(w[1], d_off), max(w[2], d_vel)
        w[3] += n
        w[4] += 1

    ok = True
    total_notes = 0
    residual = 0.0
    for c, name in enumerate(CATEGORIES):
        w = worst[c]
        if not w[4]:
            continue
        total_notes += w[3]
        residual = max(residual, max(w[:3]))
        print(f"{name:28s}: {w[4]:3d} trials {w[3]:6d} notes  max|onset|={w[0]:.9f} ms  "
              f"max|offset|={w[1]:.9f} ms  max|velocity|={w[2]:.9f}"
              + ("   (exact 0.0)" if max(w[:3]) == 0.0 else
                 f"   ULP residual {max(w[:3]):.3e}"))
        ok = ok and max(w[:3]) <= TOL
    ok = ok and total_notes > 0
    print(f"\n{n_trials} random maps (seed {seed}) vs tempo_math/dynamics_math oracle, "
          f"{total_notes} notes compared, no meico clamp warnings")
    if residual == 0.0:
        print("RESULT: EXACT (0.0 divergence)")
    elif ok:
        print(f"RESULT: EXACT within tolerance -- max residual {residual:.3e} "
              f"(<= {TOL:g}); JVM/CPython Math.pow+Math.log 1-ULP, see module docstring")
    else:
        print(f"RESULT: MISMATCH (max residual {residual:.3e} > {TOL:g})")
    sys.exit(0 if ok else 1)


# ---------------------------------------------------------------- selftest

def _reverse_elements(xml, map_name, el_name):
    """Write a map's instructions in reverse document order -- what the export did before
    it sorted, and what a model that emits rows out of order would have produced."""
    import re
    m = re.search(f"<{map_name}>(.*?)</{map_name}>", xml, re.S)
    elems = re.findall(f"<{el_name} [^>]*/>", m.group(1))
    return xml[:m.start(1)] + "".join(reversed(elems)) + xml[m.end(1):]


def expect_raise(what, fn):
    try:
        fn()
    except MpmExportError as e:
        print(f"  OK   {what:52s} -> MpmExportError: {str(e).splitlines()[0][:70]}")
        return True
    print(f"  FAIL {what:52s} -> no MpmExportError")
    return False


def selftest():
    ensure_pilot()
    os.makedirs(WORK_DIR, exist_ok=True)
    msm = os.path.join(DEBUG_DIR, "piece2.msm")
    if not os.path.exists(msm):
        sys.exit(f"selftest needs {msm}")
    score = parse_score(msm)
    ok = True

    TEMPO = [[0.0, 120.0, None, None], [3600.0, 60.0, None, None], [7200.0, 180.0, None, None]]
    DYN = [[0.0, 44.1, 109.6, 0.76, -0.55], [25200.0, 109.6, None, None, None]]
    OOR_DYN = [[0.0, 44.1, 109.6, 1.5, -2.0], [25200.0, 109.6, None, None, None]]

    print("1. input guards (no JVM)")
    ok &= expect_raise("empty tempo map", lambda: maps_to_mpm([], DYN))
    ok &= expect_raise("negative date", lambda: maps_to_mpm([[-1.0, 120.0, None, None]], DYN))
    ok &= expect_raise("NaN bpm", lambda: maps_to_mpm([[0.0, float("nan"), None, None]]))
    ok &= expect_raise("bpm = 0", lambda: maps_to_mpm([[0.0, 0.0, None, None]]))
    ok &= expect_raise("no instruction at date 0",
                       lambda: maps_to_mpm([[720.0, 120.0, None, None]]))
    ok &= expect_raise("non-numeric row field",
                       lambda: maps_to_mpm([[0.0, "allegro", None, None]]))

    print("2. canonicalization is visible in the emitted XML (no JVM)")
    sorted_xml = maps_to_mpm(TEMPO, DYN, name="perf")
    unsorted_xml = maps_to_mpm(TEMPO[::-1], DYN[::-1], name="perf")
    same = sorted_xml == unsorted_xml
    print(f"  {'OK  ' if same else 'FAIL'} reversed rows emit the sorted document")
    ok &= same
    clamped_xml = maps_to_mpm(TEMPO, OOR_DYN, name="perf")
    has = ('curvature="1.0"' in clamped_xml and 'protraction="-1.0"' in clamped_xml
           and "1.5" not in clamped_xml and "-2.0" not in clamped_xml)
    print(f"  {'OK  ' if has else 'FAIL'} curvature 1.5 / protraction -2.0 emitted as "
          f"1.0 / -1.0")
    ok &= has
    mta_xml = maps_to_mpm([[0.0, 120.0, 60.0, 1.7], [3600.0, 60.0, None, None]])
    collapsed = "transition.to" not in mta_xml and "meanTempoAt" not in mta_xml
    print(f"  {'OK  ' if collapsed else 'FAIL'} meanTempoAt 1.7 collapses to a constant "
          "at the start value")
    ok &= collapsed

    print("3. against meico (one JVM, 6 renders)")
    def w(tag, xml):
        p = os.path.join(WORK_DIR, f"self_{tag}.mpm")
        with open(p, "w") as fh:
            fh.write(xml)
        return p, os.path.join(WORK_DIR, f"self_{tag}.msm")

    # the pre-fix export: rows written in the order given (here: reversed)
    raw_unsorted = _reverse_elements(_reverse_elements(sorted_xml, "tempoMap", "tempo"),
                                     "dynamicsMap", "dynamics")
    # the pre-fix export: curvature/protraction written verbatim
    raw_oor = clamped_xml.replace('curvature="1.0"', 'curvature="1.5"').replace(
        'protraction="-1.0"', 'protraction="-2.0"')
    perturbed = maps_to_mpm([[d, b * 1.01, t, m] for d, b, t, m in TEMPO], DYN, name="perf")
    no_tempo = maps_to_mpm([], DYN, name="perf", allow_no_tempo=True)

    files = {tag: w(tag, xml) for tag, xml in [
        ("ref", sorted_xml), ("unsorted", raw_unsorted), ("clamped", clamped_xml),
        ("rawoor", raw_oor), ("perturbed", perturbed), ("notempo", no_tempo)]}
    r = run_batch([(msm, p, o) for p, o in files.values()], tag="self")
    if r.returncode != 0:
        sys.exit(f"selftest batch failed: {r.returncode}\n{r.stdout}{r.stderr}")

    ref_out = files["ref"][1]
    d = compare(ref_out, score, TEMPO, DYN)
    good = max(d[:3]) == 0.0
    print(f"  {'OK  ' if good else 'FAIL'} canonical export vs oracle: "
          f"on={d[0]:.9f} off={d[1]:.9f} vel={d[2]:.9f}")
    ok &= good

    # (a) UNSORTED ROWS -- the bug: meico sorts, the Python oracle did not
    same_render = parse_notes(files["unsorted"][1]) == parse_notes(ref_out)
    d_raw = compare(files["unsorted"][1], score, TEMPO[::-1], DYN[::-1], canonicalize=False)
    d_can = compare(files["unsorted"][1], score, TEMPO[::-1], DYN[::-1])
    print(f"  {'OK  ' if same_render else 'FAIL'} meico renders reversed rows exactly like"
          f" the sorted document")
    print(f"       pre-fix (oracle on raw rows) : max|onset| = {d_raw[0]:.6f} ms  <- the bug")
    print(f"       fixed   (canonicalized rows) : max|onset| = {d_can[0]:.9f} ms")
    ok &= same_render and d_raw[0] > 1.0 and max(d_can[:3]) == 0.0

    # (b) OUT-OF-RANGE curvature/protraction -- the bug: meico clamps on parse
    d_can = compare(files["clamped"][1], score, TEMPO, OOR_DYN)
    d_raw = compare(files["clamped"][1], score, TEMPO, OOR_DYN, canonicalize=False)
    warn_clamped = [x for x in CLAMP_WARNINGS if x in r.stderr]
    same_render = parse_notes(files["rawoor"][1]) == parse_notes(files["clamped"][1])
    print(f"  {'OK  ' if same_render else 'FAIL'} meico renders raw 1.5/-2.0 exactly like "
          f"the clamped export (it clamps on parse)")
    print(f"       pre-fix (oracle on raw values): max|velocity| = {d_raw[2]:.6f}  <- the bug")
    print(f"       fixed   (clamped export)      : max|velocity| = {d_can[2]:.9f}")
    print(f"       meico stderr clamp warnings   : {warn_clamped} (from the raw-1.5 job only)")
    ok &= same_render and d_raw[2] > 1.0 and max(d_can[:3]) == 0.0
    ok &= any("Invalid curvature value: 1.5" in l for l in r.stderr.splitlines())

    # (c) EMPTY tempo map -- renders happily and means nothing
    notes = parse_notes(files["notempo"][1])
    print(f"  OK   empty tempoMap renders with milliseconds.* on all {len(notes)} notes "
          f"(first onset {notes[0][0]}, last {notes[-1][1]:.1f} ms) -> guarded by default")

    # (d) negative controls: the comparison must be able to fail
    dp = compare(files["perturbed"][1], score, TEMPO, DYN)
    dv = compare(ref_out, score, TEMPO, [[d, v + 1.0] + rest for d, v, *rest in DYN])
    print(f"  {'OK  ' if dp[0] > 0 else 'FAIL'} negative control (bpm x1.01): "
          f"max|onset| = {dp[0]:.3f} ms")
    print(f"  {'OK  ' if dv[2] > 0 else 'FAIL'} negative control (volume +1): "
          f"max|velocity| = {dv[2]:.3f}")
    ok &= dp[0] > 0 and dv[2] > 0
    try:
        compare(ref_out, score[:-1], TEMPO, DYN)
        print("  FAIL note-count mismatch not detected")
        ok = False
    except ValueError as e:
        print(f"  OK   note-count mismatch raises: {e}")

    print("\nRESULT: " + ("ALL SELFTESTS PASS" if ok else "SELFTEST FAILURES"))
    sys.exit(0 if ok else 1)


# ---------------------------------------------------------------- formatter check

JD_PROBE = """import java.io.*; import java.util.Locale;
public class JdProbe { public static void main(String[] a) throws Exception {
  Locale.setDefault(Locale.US);
  BufferedReader r = new BufferedReader(new FileReader(a[0]));
  PrintWriter w = new PrintWriter(a[1]); String l;
  while ((l = r.readLine()) != null) { l = l.trim(); if (l.isEmpty()) continue;
    w.println(Double.toString(Double.longBitsToDouble(Long.parseUnsignedLong(l, 16)))); }
  r.close(); w.close(); } }
"""


def formats():
    """_jd must be Java's Double.toString: same spelling in this project's value domain,
    and always the same DOUBLE everywhere (JDK 17 predates the shortest-repr fix, so a
    few extreme values are spelled with one digit more than necessary)."""
    import struct
    os.makedirs(WORK_DIR, exist_ok=True)
    rng = random.Random(20260808)

    proj = [0.0, 0.25, 0.5]
    proj += [float(t) for t in range(0, 1000000, 45)]
    proj += [t + 0.5 for t in range(0, 40000, 45)]
    proj += [round(i / 100, 2) for i in range(1, 100)]
    proj += [round(i / 1000, 3) for i in range(0, 1001)]
    proj += [round(-1 + i / 1000, 3) for i in range(0, 2001)]
    inrange = ([rng.uniform(1e-3, 1e7) for _ in range(50000)]
               + [-rng.uniform(1e-3, 1e7) for _ in range(20000)])
    anyexp = []
    while len(anyexp) < 50000:
        v = struct.unpack('<d', struct.pack('<Q', rng.getrandbits(64)))[0]
        if v == v and abs(v) != float("inf"):
            anyexp.append(v)
    edges = [1e-3, -1e-3, 9.999999999999999e-4, 1e7, -1e7, 9999999.999999998, 1e-4, 5e-4,
             1e20, 1e23, 5e-324, 1.7976931348623157e308, 2.2250738585072014e-308,
             0.0, -0.0, 1.0, -1.0, 100.0, 0.1, 1 / 3, 2.675, 0.005, 12345678.0]
    domains = [("project domain (dates/mta/curv/prot)", proj),
               ("random in [1e-3, 1e7)", inrange),
               ("random bit patterns (any exponent)", anyexp),
               ("edge cases", edges)]

    src = os.path.join(WORK_DIR, "JdProbe.java")
    with open(src, "w") as fh:
        fh.write(JD_PROBE)
    bits_path, out_path = os.path.join(WORK_DIR, "jd_bits.txt"), os.path.join(WORK_DIR, "jd_java.txt")
    vals = [(n, v) for n, vs in domains for v in vs]
    with open(bits_path, "w") as fh:
        for _, v in vals:
            fh.write(f"{struct.unpack('<Q', struct.pack('<d', v))[0]:016x}\n")
    r = run(["java", src, bits_path, out_path])            # single-file source mode
    if r.returncode != 0:
        sys.exit("JdProbe failed:\n" + r.stdout + r.stderr)
    java = [l.rstrip("\n") for l in open(out_path)]
    assert len(java) == len(vals)

    stats, examples = {}, {}
    for (name, v), js in zip(vals, java):
        s = stats.setdefault(name, [0, 0, 0])
        s[0] += 1
        mine = _jd(v)
        if mine != js:
            s[1] += 1
            if struct.pack('<d', float(mine)) != struct.pack('<d', float(js)):
                s[2] += 1
            examples.setdefault(name, []).append((js, mine))

    print(f"_jd vs Double.toString on java "
          f"{subprocess.run(['java', '-version'], capture_output=True, text=True).stderr.splitlines()[0]}")
    print(f"\n{'domain':38s} {'n':>7s} {'spelling!=':>11s} {'value!=':>8s}")
    tot = [0, 0, 0]
    for name, s in stats.items():
        print(f"{name:38s} {s[0]:7d} {s[1]:11d} {s[2]:8d}")
        tot = [tot[i] + s[i] for i in range(3)]
    print(f"{'TOTAL':38s} {tot[0]:7d} {tot[1]:11d} {tot[2]:8d}")
    for name, ex in examples.items():
        print(f"\nspelling mismatches [{name}] (first 4 of {len(ex)}), all value-identical:")
        for js, mine in ex[:4]:
            print(f"   java={js:28s} ours={mine:28s} same double={float(js) == float(mine)}")
    strict = stats["project domain (dates/mta/curv/prot)"][1] + stats["random in [1e-3, 1e7)"][1]
    print(f"\n_num spot check: {[_num(x) for x in (181.7, 43.0, 0.0, -0.0, 100.123456, 2.675)]}")
    ok = tot[2] == 0 and strict == 0
    print("RESULT: " + ("EXACT in the project domain, value-preserving everywhere"
                        if ok else "MISMATCH"))
    sys.exit(0 if ok else 1)


# ---------------------------------------------------------------- pilot mode

def main():
    ensure_pilot()
    os.makedirs(WORK_DIR, exist_ok=True)

    records = [json.loads(l) for l in open(JSONL)]
    tot_notes = vel_compared = compared = byte_identical = byte_checked = 0
    worst = {"on": 0.0, "off": 0.0, "vel": 0.0}
    failures = []
    jobs, pieces = [], []

    for rec in records:
        idx = rec["id"]
        msm = os.path.join(DEBUG_DIR, f"piece{idx}.msm")
        if not os.path.exists(msm):
            print(f"# piece{idx}: no debug .msm (generator writes only the first 3) - skipped")
            continue
        mpm_path = os.path.join(WORK_DIR, f"piece{idx}_export.mpm")
        xml = maps_to_mpm(rec.get("tempo", []), rec.get("dynamics", []),
                          ppq=rec.get("ppq", 720), name="perf")
        with open(mpm_path, "w") as fh:
            fh.write(xml)
        out_msm = os.path.join(WORK_DIR, f"piece{idx}_export_augmented.msm")
        jobs.append((msm, mpm_path, out_msm))
        pieces.append((rec, idx, xml, out_msm))

    if not jobs:
        sys.exit(f"no pilot pieces found in {DEBUG_DIR}")
    r = run_batch(jobs, tag="pilot")
    if r.returncode != 0:
        sys.exit(f"RenderMpm --batch exit {r.returncode}\n{r.stdout}{r.stderr}")
    warned = [w for w in CLAMP_WARNINGS if w in r.stderr]
    if warned:
        failures.append(f"meico had to repair values we emitted: {warned}")

    for rec, idx, xml, out_msm in pieces:
        # the canonicalizer must be a no-op on the generator's own maps -- that is what
        # keeps the byte-identity property intact
        can_t, can_d = canonicalize_maps(rec.get("tempo", []), rec.get("dynamics", []))
        raw_t = [list(r_) + [None] * (4 - len(r_)) for r_ in rec.get("tempo", [])]
        raw_d = [list(r_) + [None] * (5 - len(r_)) for r_ in rec.get("dynamics", [])]
        if can_t != raw_t or can_d != raw_d:
            failures.append(f"piece{idx}: canonicalization altered the generator's maps")

        ref_mpm = os.path.join(DEBUG_DIR, f"piece{idx}.mpm")
        if os.path.exists(ref_mpm):
            byte_checked += 1
            same_bytes = open(ref_mpm, "rb").read() == xml.encode()
            byte_identical += int(same_bytes)
        else:
            same_bytes = None
            failures.append(f"piece{idx}: no generator .mpm to byte-compare against")

        try:
            rendered = parse_notes(out_msm)
        except ValueError as e:
            failures.append(f"piece{idx}: {e}")
            continue
        gt = rec["notes"]
        if len(rendered) != len(gt):
            failures.append(f"piece{idx}: note count {len(rendered)} != {len(gt)}")
            continue

        has_dyn = bool(rec.get("dynamics"))
        d_on = d_off = d_vel = 0.0
        n_vel = 0
        for (ms_on, ms_off, vel), note in zip(rendered, gt):
            gt_vel = float(note[5]) if len(note) > 5 else None
            d_on = max(d_on, abs(ms_on - float(note[3])))
            d_off = max(d_off, abs(ms_off - float(note[4])))
            if vel is not None and gt_vel is not None:
                d_vel = max(d_vel, abs(vel - gt_vel))
                n_vel += 1
        if has_dyn and n_vel != len(gt):
            failures.append(f"piece{idx}: dynamicsMap present but only {n_vel}/{len(gt)} "
                            "notes could be velocity-compared (missing attribute)")
        tot_notes += len(gt)
        vel_compared += n_vel
        compared += 1
        worst["on"] = max(worst["on"], d_on)
        worst["off"] = max(worst["off"], d_off)
        worst["vel"] = max(worst["vel"], d_vel)

        print(f"piece{idx}: {len(gt):4d} notes  "
              f"tempo={len(rec.get('tempo', []))} dyn={len(rec.get('dynamics', []))}  "
              f"max|onset|={d_on:.9f} ms  max|offset|={d_off:.9f} ms  "
              f"max|velocity|={d_vel:.9f} ({n_vel} compared)  "
              f"mpm bytes {'identical' if same_bytes else 'DIFFER'}")

    print()
    print(f"pieces validated = {compared}/{len(records)}, notes compared = {tot_notes}, "
          f"velocities compared = {vel_compared}")
    print(f"max |onset diff|    = {worst['on']:.9f} ms")
    print(f"max |offset diff|   = {worst['off']:.9f} ms")
    print(f"max |velocity diff| = {worst['vel']:.9f}")
    print(f"MPM byte-identical to meico's own serialization: {byte_identical}/{byte_checked}")

    for f in failures:
        print("FAIL " + f)
    ok = (not failures and max(worst.values()) == 0.0 and tot_notes > 0
          and vel_compared == tot_notes
          and byte_checked == compared and byte_identical == byte_checked)
    print("RESULT: " + ("EXACT (0.0 divergence, byte-identical XML)" if ok else "MISMATCH"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    if MODE == "--stress":
        stress(int(sys.argv[2]) if len(sys.argv) > 2 else 30,
               int(sys.argv[3]) if len(sys.argv) > 3 else 7)
    elif MODE == "--selftest":
        selftest()
    elif MODE == "--formats":
        formats()
    elif MODE:
        sys.exit(f"unknown mode {MODE}\n{__doc__}")
    else:
        main()
