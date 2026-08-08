import meico.msm.Msm;
import meico.mpm.Mpm;
import meico.mpm.elements.Performance;
import meico.mpm.elements.Part;
import meico.mpm.elements.maps.TempoMap;
import meico.mpm.elements.maps.RubatoMap;
import meico.mpm.elements.maps.ArticulationMap;

import nu.xom.Attribute;
import nu.xom.Element;
import nu.xom.Elements;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.util.ArrayList;
import java.util.Locale;
import java.util.Random;

/**
 * Synthetic training-data generator for the aligned-MIDI -> MPM experiment.
 *
 * Samples a random score (MSM) and a canonical-form tempoMap (MPM), renders it with
 * meico's Performance.perform(), and emits one JSON line per piece:
 * {"id":..., "ppq":720, "notes":[[dateTicks,durTicks,pitch,msOn,msOff],...],
 *  "tempo":[[dateTicks,bpm,transitionTo|null,meanTempoAt|null],...]}
 *
 * Canonical form (v0): instruction at date 0; boundaries on beat multiples; segments
 * >= 4 beats; last instruction constant (meico renders a dangling transition as inert);
 * bpm 1 decimal in [40,200] log-uniform; meanTempoAt 2 decimals in [0.15,0.85];
 * transitions change tempo by at least ~11% (|log2 ratio| >= 0.15).
 *
 * Canonical form (v3) adds -- the normative reference is ../CANONICAL.md, rule ids below:
 * - articulationMap: ~15% of distinct onset dates get exactly one articulation instruction
 *   (A1/A4: no noteid, so it applies to all notes at that date) with relativeDuration in
 *   [0.40,1.15] (A2: 2 decimals, neutral band [0.97,1.03] excluded) and
 *   absoluteVelocityChange an INTEGER in [-25,25] (A3/G6, neutral band [-2,2] excluded).
 * - rubatoMap: 50% of pieces get 1 span, 15% get 2; spans are beat-aligned, >= 8 beats,
 *   frameLength in {720,1440,2880} dividing the span length (R1/R5), intensity log-uniform
 *   in [0.45,2.2] (R3: 2 decimals, neutral band [0.95,1.05] excluded), lateStart=0 and
 *   earlyEnd=1 ALWAYS (R2, the central identifiability rule), loop=true (R4).
 *   Every span is TERMINATED by a neutral rubato element (R6: intensity=1, lateStart=0,
 *   earlyEnd=1, loop=true, frameLength inherited) at the span's end date -- without it,
 *   meico's RubatoMap.renderRubatoToMap() would keep looping the frame until the end of the
 *   piece (a rubato element's endDate is the date of the *next* rubato element, else
 *   Double.MAX_VALUE). The terminator is the identity for any frameLength.
 *   Additional constraint (see pickFrameLength; NOT yet in CANONICAL.md): the frameLength is
 *   chosen such that no tempo instruction falls strictly inside a rubato frame. Rationale:
 *   meico picks the tempo segment of a note by its *unwarped* map key but evaluates the
 *   tempo curve at the *warped* date.perf; if a frame straddled a tempo boundary, a
 *   backwards warp (intensity > 1) could push date.perf before the segment start, and
 *   Math.pow(negative, exponent) would render NaN milliseconds. If no candidate frameLength
 *   satisfies this, the span placement is REJECTED and resampled -- never silently
 *   defaulted, because a default could emit exactly the NaN-producing configuration once
 *   sub-beat tempo dates enter the domain randomization.
 *
 * Usage: SampleAndRender <outFile.jsonl> <numPieces> <seed> [maps] [debugDir]
 *   maps: comma list out of tempo,dynamics,articulation,rubato (default tempo)
 *
 *   Plus three DELIBERATELY NON-CANONICAL port-coverage switches. They exist so that the
 *   Python port (python/perf_chain.py) can be proven bit-exact on meico code paths the
 *   canonical form never reaches; datasets generated with them are for validation only and
 *   MUST NOT be used as training data:
 *     polyphony      a second, sustained voice -> overlapping notes -> NON-MONOTONE note end
 *                    dates, which is the only way to exercise the difference between
 *                    RubatoMap's pendingDurations `break` and TempoMap's `continue`
 *     stackedArtic   a second articulation instruction on some dates (violates A4) ->
 *                    exercises meico applying several ArticulationData to one note
 *     danglingTempo  keeps a transition on the LAST tempo instruction (violates G7) ->
 *                    exercises endDate == Double.MAX_VALUE as a divisor in getTempoAt()
 *     lateStart      lateStart/earlyEnd != 0/1 on 20% of spans (violates R2)
 */
public class SampleAndRender {

    static final int PPQ = 720;
    static final Random RNG = new Random();

    static boolean withDynamics = false;
    static boolean withArticulation = false;
    static boolean withRubato = false;

    // non-canonical port-coverage switches (see the class javadoc)
    static boolean withPolyphony = false;
    static boolean withStackedArtic = false;
    static boolean withDanglingTempo = false;
    static boolean withLateStart = false;

    public static void main(String[] args) throws Exception {
        Locale.setDefault(Locale.US);
        if (args.length < 3) {
            System.err.println("Usage: SampleAndRender <outFile.jsonl> <numPieces> <seed> [maps] [debugDir]");
            System.err.println("  maps: comma list, e.g. tempo or tempo,dynamics,articulation,rubato (default tempo)");
            System.exit(1);
        }
        File outFile = new File(args[0]);
        int numPieces = Integer.parseInt(args[1]);
        long seed = Long.parseLong(args[2]);
        if (args.length > 3) {
            withDynamics = args[3].contains("dynamics");
            withArticulation = args[3].contains("articulation");
            withRubato = args[3].contains("rubato");
            withPolyphony = args[3].contains("polyphony");
            withStackedArtic = args[3].contains("stackedArtic");
            withDanglingTempo = args[3].contains("danglingTempo");
            withLateStart = args[3].contains("lateStart");
            if (withPolyphony || withStackedArtic || withDanglingTempo || withLateStart)
                System.out.println("WARNING: NON-CANONICAL port-coverage mode ("
                        + (withPolyphony ? "polyphony " : "") + (withStackedArtic ? "stackedArtic " : "")
                        + (withDanglingTempo ? "danglingTempo " : "") + (withLateStart ? "lateStart " : "")
                        + ") -- validation data only, not training data");
        }
        File debugDir = args.length > 4 ? new File(args[4]) : null;
        if (debugDir != null) debugDir.mkdirs();
        if (outFile.getParentFile() != null) outFile.getParentFile().mkdirs();

        long t0 = System.currentTimeMillis();
        try (BufferedWriter w = new BufferedWriter(new FileWriter(outFile))) {
            for (int i = 0; i < numPieces; i++) {
                RNG.setSeed(seed * 1_000_003L + i);
                String line = generatePiece(i, debugDir != null && i < 3 ? debugDir : null);
                w.write(line);
                w.newLine();
                if ((i + 1) % 1000 == 0)
                    System.out.println((i + 1) + " pieces, " + (System.currentTimeMillis() - t0) + " ms");
            }
        }
        System.out.println("Done: " + numPieces + " pieces in " + (System.currentTimeMillis() - t0) + " ms -> " + outFile);
    }

    // ---------- score sampling ----------

    static class ScoreNote {
        int date, dur, pitch;
        ScoreNote(int date, int dur, int pitch) { this.date = date; this.dur = dur; this.pitch = pitch; }
    }

    static ArrayList<ScoreNote> sampleScore(int totalTicks) {
        ArrayList<ScoreNote> notes = new ArrayList<>();
        int[] durs = {180, 360, 720, 1440};
        double[] durP = {0.2, 0.4, 0.3, 0.1};
        int pitch = 48 + RNG.nextInt(24);
        int t = 0;
        while (t < totalTicks) {
            int dur = durs[pick(durP)];
            if (t + dur > totalTicks) dur = totalTicks - t;
            if (dur < 180) break;
            if (RNG.nextDouble() < 0.08) { t += dur; continue; } // rest
            int chordSize = RNG.nextDouble() < 0.15 ? 2 + RNG.nextInt(3) : 1;
            for (int c = 0; c < chordSize; c++) {
                int p = clamp(pitch + (c == 0 ? 0 : 3 + RNG.nextInt(9)), 30, 96);
                notes.add(new ScoreNote(t, dur, p));
            }
            pitch = clamp(pitch + (RNG.nextInt(15) - 7), 36, 90);
            t += dur;
        }
        if (withPolyphony) notes = addSustainedVoice(notes, totalTicks);
        return notes;
    }

    /**
     * NON-CANONICAL port coverage. Adds a slow second voice of 2..4-beat notes that overlap
     * the melody, so that note end dates are no longer monotone in map order. That is the
     * only configuration in which meico's RubatoMap pendingDurations `break` (which abandons
     * still-in-scope later entries) differs from TempoMap's `continue`. The merged list is
     * returned in the same stable (date, insertion) order meico's GenericMap will hold it in,
     * so the augmented-MSM document order the JSONL is read back from matches.
     */
    static ArrayList<ScoreNote> addSustainedVoice(ArrayList<ScoreNote> melody, int totalTicks) {
        ArrayList<ScoreNote> bass = new ArrayList<>();
        int t = 0;
        while (t < totalTicks) {
            int dur = (2 + RNG.nextInt(3)) * PPQ;                    // 2..4 beats
            if (t + dur > totalTicks) dur = totalTicks - t;
            if (dur < PPQ) break;
            bass.add(new ScoreNote(t, dur, clamp(30 + RNG.nextInt(12), 30, 96)));
            t += dur;
        }
        ArrayList<ScoreNote> merged = new ArrayList<>(melody.size() + bass.size());
        int i = 0, j = 0;
        while ((i < melody.size()) || (j < bass.size())) {           // stable merge by date
            if (j >= bass.size()) merged.add(melody.get(i++));
            else if (i >= melody.size()) merged.add(bass.get(j++));
            else if (melody.get(i).date <= bass.get(j).date) merged.add(melody.get(i++));
            else merged.add(bass.get(j++));
        }
        return merged;
    }

    static int pick(double[] p) {
        double r = RNG.nextDouble(), acc = 0;
        for (int i = 0; i < p.length; i++) { acc += p[i]; if (r < acc) return i; }
        return p.length - 1;
    }

    static int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }

    // ---------- tempo sampling (canonical form) ----------

    static class TempoInstr {
        int date;
        double bpm;
        Double transitionTo; // null = constant
        Double meanTempoAt;
    }

    static ArrayList<TempoInstr> sampleTempoMap(int totalTicks) {
        ArrayList<Integer> boundaries = new ArrayList<>();
        int beat = 0;
        int totalBeats = totalTicks / PPQ;
        while (beat < totalBeats) {
            boundaries.add(beat * PPQ);
            beat += 4 + RNG.nextInt(13); // segments of 4..16 beats
        }
        ArrayList<TempoInstr> instrs = new ArrayList<>();
        double prevEnd = Double.NaN;
        for (int i = 0; i < boundaries.size(); i++) {
            TempoInstr ti = new TempoInstr();
            ti.date = boundaries.get(i);
            boolean cont = !Double.isNaN(prevEnd) && RNG.nextDouble() < 0.6;
            ti.bpm = cont ? prevEnd : round1(logUniform(40, 200));
            boolean lastOne = i == boundaries.size() - 1;
            // G7: the last instruction is constant. withDanglingTempo deliberately breaks
            // that (port coverage for endDate == Double.MAX_VALUE inside getTempoAt()).
            boolean transition = (!lastOne || withDanglingTempo) && RNG.nextDouble() < 0.5;
            if (transition) {
                double to;
                do { to = round1(logUniform(40, 200)); }
                while (Math.abs(Math.log(to / ti.bpm) / Math.log(2)) < 0.15);
                ti.transitionTo = to;
                ti.meanTempoAt = round2(0.15 + RNG.nextDouble() * 0.70);
                prevEnd = to;
            } else {
                prevEnd = ti.bpm;
            }
            // canonical: drop a constant instruction equal to the running tempo
            if (!instrs.isEmpty()) {
                TempoInstr last = instrs.get(instrs.size() - 1);
                if (last.transitionTo == null && ti.transitionTo == null && last.bpm == ti.bpm)
                    continue;
            }
            instrs.add(ti);
        }
        return instrs;
    }

    static double logUniform(double lo, double hi) {
        return Math.exp(Math.log(lo) + RNG.nextDouble() * (Math.log(hi) - Math.log(lo)));
    }

    // ---------- dynamics sampling (canonical form, mirrors tempo) ----------

    static class DynInstr {
        int date;
        double volume;
        Double transitionTo; // null = constant
        Double curvature, protraction;
    }

    static ArrayList<DynInstr> sampleDynamicsMap(int totalTicks) {
        ArrayList<Integer> boundaries = new ArrayList<>();
        int beat = 0;
        int totalBeats = totalTicks / PPQ;
        while (beat < totalBeats) {
            boundaries.add(beat * PPQ);
            beat += 4 + RNG.nextInt(13);
        }
        ArrayList<DynInstr> instrs = new ArrayList<>();
        double prevEnd = Double.NaN;
        for (int i = 0; i < boundaries.size(); i++) {
            DynInstr di = new DynInstr();
            di.date = boundaries.get(i);
            boolean cont = !Double.isNaN(prevEnd) && RNG.nextDouble() < 0.6;
            di.volume = cont ? prevEnd : round1(30 + RNG.nextDouble() * 85); // 30..115
            boolean lastOne = i == boundaries.size() - 1;
            boolean transition = !lastOne && RNG.nextDouble() < 0.5;
            if (transition) {
                double to;
                do { to = round1(30 + RNG.nextDouble() * 85); }
                while (Math.abs(to - di.volume) < 8.0);
                di.transitionTo = to;
                di.curvature = round2(RNG.nextDouble() * 0.9);
                di.protraction = round2((RNG.nextDouble() * 1.4) - 0.7);
                prevEnd = to;
            } else {
                prevEnd = di.volume;
            }
            if (!instrs.isEmpty()) {
                DynInstr last = instrs.get(instrs.size() - 1);
                if (last.transitionTo == null && di.transitionTo == null && last.volume == di.volume)
                    continue;
            }
            instrs.add(di);
        }
        return instrs;
    }

    // ---------- articulation sampling (canonical form v3) ----------

    static class ArtInstr {
        int date;
        double relDur, velChange;
    }

    /** one instruction per chosen onset date, no noteid -> applies to all notes at that date */
    static ArrayList<ArtInstr> sampleArticulationMap(ArrayList<ScoreNote> score) {
        ArrayList<ArtInstr> out = new ArrayList<>();
        int prevDate = -1;
        for (ScoreNote n : score) {
            if (n.date == prevDate) continue;                       // distinct onset dates only
            prevDate = n.date;
            if (RNG.nextDouble() >= 0.15) continue;                 // A1: ~15% of the dates
            out.add(sampleArticulation(n.date));
            // NON-CANONICAL port coverage: a second instruction at the same date (violates
            // A4). meico keeps a per-note ArrayList<ArticulationData> and applies all of
            // them in map order; a date -> single-instruction lookup would silently drop it.
            if (withStackedArtic && (RNG.nextDouble() < 0.35))
                out.add(sampleArticulation(n.date));
        }
        return out;
    }

    static ArtInstr sampleArticulation(int date) {
        ArtInstr a = new ArtInstr();
        a.date = date;
        do { a.relDur = round2(0.40 + RNG.nextDouble() * 0.75); }        // A2: [0.40, 1.15]
        while ((a.relDur >= 0.97) && (a.relDur <= 1.03));                // exclude the neutral band
        // A3/G6: absoluteVelocityChange is an INTEGER in [-25, 25]; MIDI velocity is
        // integral, so a fractional deviation is below the quantiser and costs DSL tokens
        // for nothing. (Up to and including the first v3 pilots this was sampled with one
        // decimal, which violated G6.)
        do { a.velChange = Math.rint(-25.0 + RNG.nextDouble() * 50.0); }  // [-25, 25]
        while ((a.velChange >= -2.0) && (a.velChange <= 2.0));           // exclude the neutral band
        return a;
    }

    // ---------- rubato sampling (canonical form v3) ----------

    static class RubInstr {
        int date, frameLength;
        double intensity, lateStart, earlyEnd;
        boolean loop;
    }

    /**
     * Pick a frameLength that divides the span length (R1/R5) and does not let any tempo
     * instruction fall strictly inside a frame. With the current beat-aligned tempo dates 720
     * always qualifies, but that is a property of the sampler, not an invariant: once the
     * planned domain randomization introduces sub-beat tempo dates (90/240/540 ticks), no
     * candidate may qualify.
     *
     * @return a valid frameLength, or 0 if there is none -- the caller must then REJECT the
     *         span placement. Returning a default instead would silently emit the one
     *         configuration that renders NaN milliseconds (a tempo instruction strictly
     *         inside a frame plus a backwards warp pushes date.perf before the segment start,
     *         and Math.pow(negative, exponent) is NaN).
     */
    static int pickFrameLength(int startTick, int endTick, ArrayList<TempoInstr> tempi) {
        int[] cand = {720, 1440, 2880};
        ArrayList<Integer> valid = new ArrayList<>();
        int spanLen = endTick - startTick;
        for (int fl : cand) {
            if (spanLen % fl != 0) continue;
            boolean good = true;
            for (TempoInstr ti : tempi) {
                if ((ti.date > startTick) && (ti.date < endTick) && (((ti.date - startTick) % fl) != 0)) {
                    good = false;
                    break;
                }
            }
            if (good) valid.add(fl);
        }
        if (valid.isEmpty()) return 0;                          // no valid frame -> reject
        return valid.get(RNG.nextInt(valid.size()));
    }

    static ArrayList<RubInstr> sampleRubatoMap(int totalTicks, ArrayList<TempoInstr> tempi) {
        ArrayList<RubInstr> out = new ArrayList<>();
        int totalBeats = totalTicks / PPQ;
        double roll = RNG.nextDouble();
        int nSpans = (roll < 0.50) ? 1 : ((roll < 0.65) ? 2 : 0);
        if (nSpans == 0) return out;
        if (totalBeats < 8) return out;
        if ((nSpans == 2) && (totalBeats < 17)) nSpans = 1;         // 8 + 1 gap + 8

        int[] s = new int[2];
        int[] len = new int[2];
        int[] frame = new int[2];
        boolean ok = false;
        // Rejection sampling: a placement is only accepted if EVERY span it contains has at
        // least one valid frameLength (pickFrameLength != 0). No silent fallback.
        // Anti-skew (CANONICAL.md follow-up): sample the DESIRED frameLength first and
        // draw span lengths as multiples of it; pickFrameLength then only validates R8.
        // Without this, span lengths uniform in [8,24] make 720 valid ~always and 2880
        // rarely (observed 85/12/4% skew over 297 spans).
        for (int attempt = 0; (attempt < 100) && !ok; ++attempt) {
            int[] frameCand = {720, 1440, 2880};
            for (int i = 0; i < nSpans; ++i) {
                int f = frameCand[RNG.nextInt(3)];
                int fBeats = f / PPQ;
                int minMult = (8 + fBeats - 1) / fBeats;            // >= 8 beats
                int maxMult = 24 / fBeats;
                len[i] = fBeats * (minMult + RNG.nextInt(maxMult - minMult + 1));
                frame[i] = f;
            }
            if (nSpans == 1) {
                if (len[0] > totalBeats) continue;
                s[0] = RNG.nextInt(totalBeats - len[0] + 1);
            } else {
                int slack = totalBeats - len[0] - len[1] - 1;       // >= 1 beat gap between the spans
                if (slack < 0) continue;
                int a = RNG.nextInt(slack + 1);
                int b = RNG.nextInt(slack - a + 1);
                s[0] = a;
                s[1] = a + len[0] + 1 + b;
            }
            ok = true;
            for (int i = 0; i < nSpans; ++i) {
                // validate the desired frame against R8; if invalid, resample placement
                int startTick = s[i] * PPQ, endTick = (s[i] + len[i]) * PPQ;
                boolean good = true;
                for (TempoInstr ti : tempi) {
                    if ((ti.date > startTick) && (ti.date < endTick)
                            && (((ti.date - startTick) % frame[i]) != 0)) {
                        good = false;
                        break;
                    }
                }
                if (!good) { ok = false; break; }
            }
        }
        if (!ok) return out;                                        // piece gets no rubato

        for (int i = 0; i < nSpans; ++i) {
            int startTick = s[i] * PPQ;
            int endTick = (s[i] + len[i]) * PPQ;

            RubInstr r = new RubInstr();
            r.date = startTick;
            r.frameLength = frame[i];
            // R3 with the frame-dependent observability deadband from CANONICAL.md:
            // effects below ~5 ms are unobservable; the widest normative band is
            // [0.89, 1.12], applied uniformly for all frameLengths (conservative).
            do { r.intensity = round2(logUniform(0.45, 2.2)); }
            while ((r.intensity >= 0.89) && (r.intensity <= 1.12));
            // R2: lateStart = 0, earlyEnd = 1, ALWAYS -- the central identifiability rule
            // (frame boundaries stay fixed points, so the warp adds no net displacement at
            // the frame grid and cannot be re-read as a tempo/asynchrony offset). Up to and
            // including the first v3 pilots 20% of the spans used lateStart != 0, which
            // violated R2. The non-canonical branch survives only as port coverage.
            r.lateStart = 0.0;
            r.earlyEnd = 1.0;
            if (withLateStart && (RNG.nextDouble() < 0.20)) {
                r.lateStart = round2(0.01 + RNG.nextDouble() * 0.14);    // (0, 0.15]
                r.earlyEnd = round2(0.85 + RNG.nextDouble() * 0.14);     // [0.85, 1)
            }
            r.loop = true;                                          // R4
            out.add(r);

            // R6: neutral terminator that ends the looped span. loop = TRUE (meico's default
            // is false; with loop=false the identity would only cover the first frame, which
            // renders the same but is a different object than the DSL 'X endDate' token and
            // than what the DSL->MPM export bridge emits).
            RubInstr term = new RubInstr();
            term.date = endTick;
            term.frameLength = frame[i];                            // inherited, R6
            term.intensity = 1.0;
            term.lateStart = 0.0;
            term.earlyEnd = 1.0;
            term.loop = true;
            out.add(term);
        }
        return out;
    }

    static double round1(double v) { return Math.round(v * 10.0) / 10.0; }
    static double round2(double v) { return Math.round(v * 100.0) / 100.0; }

    // ---------- MSM/MPM assembly + rendering ----------

    static String generatePiece(int index, File debugDir) throws Exception {
        int totalBeats = 16 + RNG.nextInt(33); // 16..48 quarters
        int totalTicks = totalBeats * PPQ;
        ArrayList<ScoreNote> score = sampleScore(totalTicks);
        ArrayList<TempoInstr> tempi = sampleTempoMap(totalTicks);
        ArrayList<DynInstr> dyns = withDynamics ? sampleDynamicsMap(totalTicks) : new ArrayList<>();
        ArrayList<ArtInstr> artics = withArticulation ? sampleArticulationMap(score) : new ArrayList<ArtInstr>();
        ArrayList<RubInstr> rubs = withRubato ? sampleRubatoMap(totalTicks, tempi) : new ArrayList<RubInstr>();

        Msm msm = Msm.createMsm("piece" + index, null, PPQ);
        Element part = Msm.makePart("Piano", 1, 0, 0);
        Element dated = part.getFirstChildElement("dated");
        dated.getFirstChildElement("timeSignatureMap").appendChild(Msm.makeTimeSignature(0, 4, 4, null));
        Element scoreEl = dated.getFirstChildElement("score");
        for (int i = 0; i < score.size(); i++) {
            ScoreNote n = score.get(i);
            Element note = new Element("note");
            note.addAttribute(new Attribute("xml:id", "http://www.w3.org/XML/1998/namespace", "n" + i));
            note.addAttribute(new Attribute("date", Double.toString(n.date)));
            note.addAttribute(new Attribute("midi.pitch", Double.toString(n.pitch)));
            note.addAttribute(new Attribute("pitchname", "x"));
            note.addAttribute(new Attribute("accidentals", "0.0"));
            note.addAttribute(new Attribute("octave", "3.0"));
            note.addAttribute(new Attribute("duration", Double.toString(n.dur)));
            scoreEl.appendChild(note);
        }
        msm.addPart(part);
        msm.setFile(new File("piece" + index + ".msm"));

        Mpm mpm = Mpm.createMpm();
        Performance perf = Performance.createPerformance("perf", PPQ);
        mpm.addPerformance(perf);
        TempoMap tempoMap = TempoMap.createTempoMap();
        for (TempoInstr ti : tempi) {
            if (ti.transitionTo != null)
                tempoMap.addTempo(ti.date, fmt(ti.bpm), fmt(ti.transitionTo), 0.25, ti.meanTempoAt);
            else
                tempoMap.addTempo(ti.date, fmt(ti.bpm), 0.25);
        }
        perf.getGlobal().getDated().addMap(tempoMap);
        if (!dyns.isEmpty()) {
            meico.mpm.elements.maps.DynamicsMap dynMap =
                meico.mpm.elements.maps.DynamicsMap.createDynamicsMap();
            for (DynInstr di : dyns) {
                if (di.transitionTo != null)
                    dynMap.addDynamics(di.date, fmt(di.volume), fmt(di.transitionTo), di.curvature, di.protraction);
                else
                    dynMap.addDynamics(di.date, fmt(di.volume));
            }
            perf.getGlobal().getDated().addMap(dynMap);
        }
        if (!artics.isEmpty()) {
            ArticulationMap articMap = ArticulationMap.createArticulationMap();
            for (ArtInstr a : artics) {
                // date, absoluteDuration, absoluteDurationChange, relativeDuration, absoluteDurationMs,
                // absoluteDurationChangeMs, absoluteVelocityChange, absoluteVelocity, relativeVelocity,
                // absoluteDelayMs, absoluteDelay, detuneCents, detuneHz, noteid, id
                articMap.addArticulation(a.date, null, null, a.relDur, null, null,
                                         a.velChange, null, null, null, null, null, null, null, null);
            }
            perf.getGlobal().getDated().addMap(articMap);
        }
        if (!rubs.isEmpty()) {
            RubatoMap rubMap = RubatoMap.createRubatoMap();
            for (RubInstr r : rubs)
                rubMap.addRubato(r.date, r.frameLength, r.intensity, r.lateStart, r.earlyEnd, r.loop);
            perf.getGlobal().getDated().addMap(rubMap);
        }
        perf.addPart(Part.createPart("Piano", 1, 0, 0));

        Msm augmented = perf.perform(msm);

        if (debugDir != null) {
            try (FileWriter fw = new FileWriter(new File(debugDir, "piece" + index + ".msm"))) { fw.write(msm.toXML()); }
            try (FileWriter fw = new FileWriter(new File(debugDir, "piece" + index + ".mpm"))) { fw.write(mpm.toXML()); }
            try (FileWriter fw = new FileWriter(new File(debugDir, "piece" + index + "_augmented.msm"))) { fw.write(augmented.toXML()); }
        }

        // extract per-note performance attributes from the augmented MSM
        StringBuilder sb = new StringBuilder(16384);
        sb.append("{\"id\":").append(index).append(",\"ppq\":").append(PPQ).append(",\"notes\":[");
        Elements parts = augmented.getRootElement().getChildElements("part");
        boolean first = true;
        for (int pi = 0; pi < parts.size(); pi++) {
            Element sc = parts.get(pi).getFirstChildElement("dated").getFirstChildElement("score");
            if (sc == null) continue;
            Elements notes = sc.getChildElements("note");
            for (int ni = 0; ni < notes.size(); ni++) {
                Element n = notes.get(ni);
                if (!first) sb.append(',');
                first = false;
                String vel = n.getAttributeValue("velocity");
                sb.append('[')
                  .append(stripZero(n.getAttributeValue("date"))).append(',')
                  .append(stripZero(n.getAttributeValue("duration"))).append(',')
                  .append(stripZero(n.getAttributeValue("midi.pitch"))).append(',')
                  .append(n.getAttributeValue("milliseconds.date")).append(',')
                  .append(n.getAttributeValue("milliseconds.date.end")).append(',')
                  .append(vel == null ? "100" : stripZero(vel))
                  .append(']');
            }
        }
        sb.append("],\"tempo\":[");
        for (int i = 0; i < tempi.size(); i++) {
            TempoInstr ti = tempi.get(i);
            if (i > 0) sb.append(',');
            sb.append('[').append(ti.date).append(',').append(fmt(ti.bpm)).append(',')
              .append(ti.transitionTo == null ? "null" : fmt(ti.transitionTo)).append(',')
              .append(ti.meanTempoAt == null ? "null" : fmt(ti.meanTempoAt)).append(']');
        }
        sb.append("],\"dynamics\":[");
        for (int i = 0; i < dyns.size(); i++) {
            DynInstr di = dyns.get(i);
            if (i > 0) sb.append(',');
            sb.append('[').append(di.date).append(',').append(fmt(di.volume)).append(',')
              .append(di.transitionTo == null ? "null" : fmt(di.transitionTo)).append(',')
              .append(di.curvature == null ? "null" : fmt(di.curvature)).append(',')
              .append(di.protraction == null ? "null" : fmt(di.protraction)).append(']');
        }
        sb.append("],\"articulation\":[");
        for (int i = 0; i < artics.size(); i++) {
            ArtInstr a = artics.get(i);
            if (i > 0) sb.append(',');
            sb.append('[').append(a.date).append(',').append(fmt(a.relDur)).append(',')
              .append(fmt(a.velChange)).append(']');
        }
        sb.append("],\"rubato\":[");
        for (int i = 0; i < rubs.size(); i++) {
            RubInstr r = rubs.get(i);
            if (i > 0) sb.append(',');
            sb.append('[').append(r.date).append(',').append(r.frameLength).append(',')
              .append(fmt(r.intensity)).append(',').append(fmt(r.lateStart)).append(',')
              .append(fmt(r.earlyEnd)).append(',').append(r.loop ? 1 : 0).append(']');
        }
        sb.append("]}");
        return sb.toString();
    }

    static String fmt(double v) {
        String s = String.format(Locale.US, "%.2f", v);
        while (s.endsWith("0")) s = s.substring(0, s.length() - 1);
        if (s.endsWith(".")) s = s.substring(0, s.length() - 1);
        return s;
    }

    /** "1440.0" -> "1440" for compact ints, otherwise keep as-is */
    static String stripZero(String s) {
        if (s == null) return "null";
        if (s.endsWith(".0")) return s.substring(0, s.length() - 2);
        return s;
    }
}
