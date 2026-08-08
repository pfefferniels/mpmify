import meico.msm.Msm;
import meico.mpm.Mpm;
import meico.mpm.elements.Performance;
import meico.mpm.elements.Part;
import meico.mpm.elements.maps.TempoMap;
import meico.mpm.elements.maps.RubatoMap;

import nu.xom.Attribute;
import nu.xom.Element;
import nu.xom.Elements;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.util.ArrayList;
import java.util.Locale;
import java.util.Random;
import java.util.TreeSet;

/**
 * Small meico probe for the identifiability study (Team B).
 *
 * Two modes.
 *
 * mode "iso" (default) -- pieces with ONE constant tempo instruction plus one
 * canonical rubato span (lateStart=0, earlyEnd=1, loop=true, closed by a neutral
 * terminator with intensity=1).  This isolates
 * RubatoMap.computeRubatoTransformation: it proves the pure-Python warp, but says
 * nothing about how rubato composes with a multi-segment tempo map.
 *
 * mode "multi" -- pieces with a MULTI-SEGMENT tempo map (constants and power
 * transitions) whose boundaries deliberately fall STRICTLY INSIDE rubato frames.
 * This is the adversarial case for the composition, because meico
 *   (a) picks the tempo segment of a note by its *unwarped* GenericMap key
 *       (TempoMap.java:396-404 tests mapEntry.getKey() against td.startDate/endDate),
 *   (b) but evaluates the tempo formula at the *warped* date.perf, which
 *       RubatoMap.java:368 has already rewritten without touching the key.
 * So a note can be rendered with a tempo segment that does not contain its own
 * performance date -- including date.perf < td.startDate, where a power transition
 * hits Math.pow(negative, non-integral exponent) = NaN.  Pieces in this mode are
 * therefore allowed to contain NaN milliseconds; that is meico's real behaviour and
 * the reason canonical form forbids the configuration (CANONICAL.md R8).
 *
 * Output: one JSON line per piece,
 *   {"id":..,"ppq":720,"notes":[[date,dur,pitch,msOn,msOff,vel],..],
 *    "tempo":[[date,bpm,to|null,mta|null],..],
 *    "rubato":[[date,frameLength,intensity,endDate],..],
 *    "straddle":true|false}          (only in mode "multi")
 *
 * Usage: RubatoProbe <out.jsonl> <numPieces> <seed> [iso|multi]
 */
public class RubatoProbe {

    static final int PPQ = 720;
    static final Random RNG = new Random();

    public static void main(String[] args) throws Exception {
        Locale.setDefault(Locale.US);
        if (args.length < 3) {
            System.err.println("Usage: RubatoProbe <out.jsonl> <numPieces> <seed> [iso|multi]");
            System.exit(1);
        }
        File out = new File(args[0]);
        int num = Integer.parseInt(args[1]);
        long seed = Long.parseLong(args[2]);
        String mode = (args.length > 3) ? args[3] : "iso";
        if (!mode.equals("iso") && !mode.equals("multi")) {
            System.err.println("unknown mode: " + mode);
            System.exit(1);
        }
        if (out.getParentFile() != null) out.getParentFile().mkdirs();

        try (BufferedWriter w = new BufferedWriter(new FileWriter(out))) {
            for (int i = 0; i < num; i++) {
                RNG.setSeed(seed * 1_000_003L + i);
                w.write(mode.equals("multi") ? generatePieceMulti(i) : generatePiece(i));
                w.newLine();
            }
        }
        System.out.println("RubatoProbe[" + mode + "] wrote " + num + " pieces -> " + out);
    }

    static class ScoreNote { int date, dur, pitch;
        ScoreNote(int d, int u, int p) { date = d; dur = u; pitch = p; } }

    static ArrayList<ScoreNote> sampleScore(int totalTicks) {
        ArrayList<ScoreNote> notes = new ArrayList<>();
        int[] durs = {180, 360, 720};
        int pitch = 60;
        int t = 0;
        while (t < totalTicks) {
            int dur = durs[RNG.nextInt(durs.length)];
            if (t + dur > totalTicks) dur = totalTicks - t;
            if (dur < 180) break;
            notes.add(new ScoreNote(t, dur, pitch));
            pitch = Math.max(40, Math.min(84, pitch + RNG.nextInt(9) - 4));
            t += dur;
        }
        return notes;
    }

    static double round1(double v) { return Math.round(v * 10.0) / 10.0; }
    static double round2(double v) { return Math.round(v * 100.0) / 100.0; }

    static String fmt(double v) {
        String s = String.format(Locale.US, "%.4f", v);
        while (s.endsWith("0")) s = s.substring(0, s.length() - 1);
        if (s.endsWith(".")) s = s.substring(0, s.length() - 1);
        return s;
    }

    static String generatePiece(int index) throws Exception {
        int totalBeats = 24 + RNG.nextInt(25);           // 24..48 quarters
        int totalTicks = totalBeats * PPQ;
        ArrayList<ScoreNote> score = sampleScore(totalTicks);

        // --- tempo: canonical, here a single constant so the rubato is isolated ---
        double bpm = round1(60 + RNG.nextDouble() * 80);

        // --- rubato: one canonical span ---
        int[] frames = {720, 1440, 2880};
        int frame = frames[RNG.nextInt(frames.length)];
        int frameBeats = frame / PPQ;
        int maxStartBeat = Math.max(0, totalBeats - 8);
        int startBeat = (maxStartBeat <= 0) ? 0
                : (RNG.nextInt(maxStartBeat / frameBeats + 1)) * frameBeats;
        int spanFrames = 8 / frameBeats + RNG.nextInt(3);
        int spanBeats = spanFrames * frameBeats;
        if (startBeat + spanBeats > totalBeats) spanBeats = totalBeats - startBeat;
        spanBeats = (spanBeats / frameBeats) * frameBeats;
        if (spanBeats < frameBeats) { startBeat = 0; spanBeats = frameBeats; }
        int startTick = startBeat * PPQ;
        int endTick = (startBeat + spanBeats) * PPQ;

        double intensity;
        do { intensity = round2(0.45 + RNG.nextDouble() * 1.75); }
        while (intensity > 0.95 && intensity < 1.05);

        Msm msm = buildMsm(index, score);

        Mpm mpm = Mpm.createMpm();
        Performance perf = Performance.createPerformance("perf", PPQ);
        mpm.addPerformance(perf);

        TempoMap tempoMap = TempoMap.createTempoMap();
        tempoMap.addTempo(0, fmt(bpm), 0.25);
        perf.getGlobal().getDated().addMap(tempoMap);

        RubatoMap rubatoMap = RubatoMap.createRubatoMap();
        rubatoMap.addRubato(startTick, frame, intensity, 0.0, 1.0, true);
        // neutral terminator: identity warp, closes the span (canonical form)
        rubatoMap.addRubato(endTick, frame, 1.0, 0.0, 1.0, true);
        perf.getGlobal().getDated().addMap(rubatoMap);

        perf.addPart(Part.createPart("Piano", 1, 0, 0));
        Msm augmented = perf.perform(msm);

        StringBuilder sb = new StringBuilder(16384);
        sb.append("{\"id\":").append(index).append(",\"ppq\":").append(PPQ)
          .append(",\"notes\":[");
        appendNotes(sb, augmented);
        sb.append("],\"tempo\":[[0,").append(fmt(bpm)).append(",null,null]]");
        sb.append(",\"rubato\":[[").append(startTick).append(',').append(frame)
          .append(',').append(fmt(intensity)).append(',').append(endTick)
          .append("]]}");
        return sb.toString();
    }

    // ----------------------------------------------------------------- //
    // mode "multi": multi-segment tempo map whose boundaries fall strictly
    // inside the rubato frames -- the adversarial case for the composition
    // ----------------------------------------------------------------- //

    static class TempoI {
        int date; double bpm; Double to; Double mta;
        TempoI(int d, double b) { date = d; bpm = b; }
    }

    static String generatePieceMulti(int index) throws Exception {
        int totalBeats = 24 + RNG.nextInt(25);           // 24..48 quarters
        int totalTicks = totalBeats * PPQ;
        ArrayList<ScoreNote> score = sampleScore(totalTicks);

        // --- rubato span (placed first; the tempo boundaries then straddle it) ---
        int[] frames = {720, 1440, 2880};
        int frame = frames[RNG.nextInt(frames.length)];
        int frameBeats = frame / PPQ;
        int spanFrames = Math.max(2, 8 / frameBeats + RNG.nextInt(3));
        int spanBeats = spanFrames * frameBeats;
        if (spanBeats > totalBeats) { spanBeats = (totalBeats / frameBeats) * frameBeats; }
        int maxStartBeat = totalBeats - spanBeats;
        int startBeat = (maxStartBeat <= 0) ? 0
                : (RNG.nextInt(maxStartBeat / frameBeats + 1)) * frameBeats;
        int startTick = startBeat * PPQ;
        int endTick = (startBeat + spanBeats) * PPQ;

        double intensity;
        do { intensity = round2(0.45 + RNG.nextDouble() * 1.75); }
        while (intensity > 0.95 && intensity < 1.05);

        // --- tempo boundaries: deliberately inside the frames where possible ---
        TreeSet<Integer> bset = new TreeSet<>();
        bset.add(0);
        boolean straddle = false;
        if (frameBeats >= 2) {                                  // a 1-beat frame cannot be
            bset.add(startTick + frame / 2);                    // straddled on the beat grid
            if (spanFrames >= 2) bset.add(startTick + frame + frame / 2);
            straddle = true;
        }
        int extra = RNG.nextInt(totalBeats) * PPQ;              // one more boundary anywhere
        if (extra > 0 && extra < totalTicks) bset.add(extra);
        ArrayList<Integer> bnds = new ArrayList<>(bset);

        ArrayList<TempoI> tempi = new ArrayList<>();
        for (int i = 0; i < bnds.size(); i++) {
            double bpm = round1(Math.exp(Math.log(50) + RNG.nextDouble()
                                         * (Math.log(160) - Math.log(50))));
            TempoI t = new TempoI(bnds.get(i), bpm);
            if ((i < bnds.size() - 1) && (RNG.nextDouble() < 0.5)) {     // last stays constant
                double lg = 0.2 + RNG.nextDouble() * 0.6;
                if (RNG.nextBoolean()) lg = -lg;
                t.to = round1(bpm * Math.pow(2.0, lg));
                t.mta = round2(0.15 + RNG.nextDouble() * 0.70);
            }
            tempi.add(t);
        }

        Msm msm = buildMsm(index, score);

        Mpm mpm = Mpm.createMpm();
        Performance perf = Performance.createPerformance("perf", PPQ);
        mpm.addPerformance(perf);

        TempoMap tempoMap = TempoMap.createTempoMap();
        for (TempoI t : tempi) {
            if (t.to == null) tempoMap.addTempo(t.date, fmt(t.bpm), 0.25);
            else tempoMap.addTempo(t.date, fmt(t.bpm), fmt(t.to), 0.25, t.mta);
        }
        perf.getGlobal().getDated().addMap(tempoMap);

        RubatoMap rubatoMap = RubatoMap.createRubatoMap();
        rubatoMap.addRubato(startTick, frame, intensity, 0.0, 1.0, true);
        rubatoMap.addRubato(endTick, frame, 1.0, 0.0, 1.0, true);
        perf.getGlobal().getDated().addMap(rubatoMap);

        perf.addPart(Part.createPart("Piano", 1, 0, 0));
        Msm augmented = perf.perform(msm);

        StringBuilder sb = new StringBuilder(16384);
        sb.append("{\"id\":").append(index).append(",\"ppq\":").append(PPQ)
          .append(",\"notes\":[");
        appendNotes(sb, augmented);
        sb.append("],\"tempo\":[");
        for (int i = 0; i < tempi.size(); i++) {
            TempoI t = tempi.get(i);
            if (i > 0) sb.append(',');
            sb.append('[').append(t.date).append(',').append(fmt(t.bpm)).append(',')
              .append(t.to == null ? "null" : fmt(t.to)).append(',')
              .append(t.mta == null ? "null" : fmt(t.mta)).append(']');
        }
        sb.append("],\"rubato\":[[").append(startTick).append(',').append(frame)
          .append(',').append(fmt(intensity)).append(',').append(endTick).append("]]");
        // meico's OWN warped tick dates (attribute date.perf, written by RubatoMap
        // before TempoMap reads it).  Emitting them lets the Python side separate
        // "is the composition model right" (must be bit-exact) from "does CPython's
        // libm pow agree with java.lang.Math.pow" (1 ULP, irreducible).
        sb.append(",\"perf\":[");
        appendPerfDates(sb, augmented);
        sb.append(']');
        sb.append(",\"straddle\":").append(straddle).append('}');
        return sb.toString();
    }

    // ----------------------------------------------------------------- //

    static Msm buildMsm(int index, ArrayList<ScoreNote> score) {
        Msm msm = Msm.createMsm("piece" + index, null, PPQ);
        Element part = Msm.makePart("Piano", 1, 0, 0);
        Element dated = part.getFirstChildElement("dated");
        dated.getFirstChildElement("timeSignatureMap")
             .appendChild(Msm.makeTimeSignature(0, 4, 4, null));
        Element scoreEl = dated.getFirstChildElement("score");
        for (int i = 0; i < score.size(); i++) {
            ScoreNote n = score.get(i);
            Element note = new Element("note");
            note.addAttribute(new Attribute("xml:id",
                    "http://www.w3.org/XML/1998/namespace", "n" + i));
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
        return msm;
    }

    static void appendNotes(StringBuilder sb, Msm augmented) {
        Elements parts = augmented.getRootElement().getChildElements("part");
        boolean first = true;
        for (int pi = 0; pi < parts.size(); pi++) {
            Element sc = parts.get(pi).getFirstChildElement("dated")
                                      .getFirstChildElement("score");
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
    }

    static void appendPerfDates(StringBuilder sb, Msm augmented) {
        Elements parts = augmented.getRootElement().getChildElements("part");
        boolean first = true;
        for (int pi = 0; pi < parts.size(); pi++) {
            Element sc = parts.get(pi).getFirstChildElement("dated")
                                      .getFirstChildElement("score");
            if (sc == null) continue;
            Elements notes = sc.getChildElements("note");
            for (int ni = 0; ni < notes.size(); ni++) {
                if (!first) sb.append(',');
                first = false;
                sb.append(notes.get(ni).getAttributeValue("date.perf"));
            }
        }
    }

    static String stripZero(String s) {
        if (s == null) return "null";
        if (s.endsWith(".0")) return s.substring(0, s.length() - 2);
        return s;
    }
}
