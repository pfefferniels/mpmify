import meico.msm.Msm;
import meico.mpm.Mpm;
import meico.mpm.elements.Performance;
import meico.mpm.elements.Part;
import meico.mpm.elements.maps.TempoMap;
import meico.mpm.elements.maps.MovementMap;
import meico.mpm.elements.maps.data.MovementData;

import nu.xom.Attribute;
import nu.xom.Element;
import nu.xom.Elements;

import java.io.File;
import java.io.FileWriter;
import java.util.ArrayList;

/**
 * Round-trip verification of the 2026-08-08 movement fixes:
 * (1) controller parsed from XML (was: assigned to xmlId via wrong-namespace lookup)
 * (2) controller serialized by addMovement(MovementData) (was: dropped)
 * (3) curvature/protraction parsed by getMovementDataOf (was: defaults always used)
 *
 * Builds an MPM with controller="soft", curvature=0.8, protraction=0.5; renders
 * in-memory; serializes + re-parses + renders again; and renders a defaults variant.
 * PASS iff in-memory == re-parsed (bit-identical positions, controller preserved)
 * AND re-parsed != defaults variant (curvature/protraction actually take effect).
 */
public class MovementFixTest {
    public static void main(String[] args) throws Exception {
        File dir = new File(args.length > 0 ? args[0] : "/tmp/movement_fix_test");
        dir.mkdirs();

        Msm msm = buildMsm();
        Mpm mpm = buildMpm(0.8, 0.5, "soft");
        Msm aug1 = mpm.getAllPerformances().get(0).perform(msm);
        ArrayList<double[]> pos1 = positions(aug1);
        String ctrl1 = controllerOf(aug1);

        File msmFile = new File(dir, "test.msm");
        File mpmFile = new File(dir, "test.mpm");
        try (FileWriter w = new FileWriter(msmFile)) { w.write(buildMsm().toXML()); }
        try (FileWriter w = new FileWriter(mpmFile)) { w.write(mpm.toXML()); }
        Msm msm2 = new Msm(msmFile);
        Mpm mpm2 = new Mpm(mpmFile);
        Msm aug2 = mpm2.getAllPerformances().get(0).perform(msm2);
        ArrayList<double[]> pos2 = positions(aug2);
        String ctrl2 = controllerOf(aug2);

        Msm aug3 = buildMpm(null, null, "soft").getAllPerformances().get(0).perform(buildMsm());
        ArrayList<double[]> pos3 = positions(aug3);

        boolean sameRoundTrip = pos1.size() == pos2.size();
        double maxDiff = 0;
        if (sameRoundTrip)
            for (int i = 0; i < pos1.size(); i++) {
                maxDiff = Math.max(maxDiff, Math.abs(pos1.get(i)[0] - pos2.get(i)[0]));
                maxDiff = Math.max(maxDiff, Math.abs(pos1.get(i)[1] - pos2.get(i)[1]));
            }
        boolean curvatureMatters = pos2.size() != pos3.size() || differ(pos2, pos3);

        System.out.println("in-memory positions: " + pos1.size() + " (controller " + ctrl1 + ")");
        System.out.println("re-parsed positions: " + pos2.size() + " (controller " + ctrl2 + ")");
        System.out.println("defaults  positions: " + pos3.size());
        System.out.println("round-trip identical: " + (sameRoundTrip && maxDiff == 0.0)
                + " (maxDiff " + maxDiff + ")");
        System.out.println("controller preserved: " + ("soft".equals(ctrl1) && "soft".equals(ctrl2)));
        System.out.println("curvature/protraction take effect: " + curvatureMatters);
        boolean pass = sameRoundTrip && maxDiff == 0.0
                && "soft".equals(ctrl1) && "soft".equals(ctrl2) && curvatureMatters;
        System.out.println(pass ? "MOVEMENT_FIX_TEST_PASS" : "MOVEMENT_FIX_TEST_FAIL");
        System.exit(pass ? 0 : 1);
    }

    static boolean differ(ArrayList<double[]> a, ArrayList<double[]> b) {
        if (a.size() != b.size()) return true;
        for (int i = 0; i < a.size(); i++)
            if (a.get(i)[0] != b.get(i)[0] || a.get(i)[1] != b.get(i)[1]) return true;
        return false;
    }

    static Msm buildMsm() {
        Msm msm = Msm.createMsm("movement fix test", null, 720);
        Element part = Msm.makePart("Piano", 1, 0, 0);
        Element dated = part.getFirstChildElement("dated");
        dated.getFirstChildElement("timeSignatureMap").appendChild(Msm.makeTimeSignature(0, 4, 4, null));
        Element score = dated.getFirstChildElement("score");
        for (int i = 0; i < 8; i++) {
            Element note = new Element("note");
            note.addAttribute(new Attribute("xml:id", "http://www.w3.org/XML/1998/namespace", "n" + i));
            note.addAttribute(new Attribute("date", Double.toString(i * 720.0)));
            note.addAttribute(new Attribute("midi.pitch", "60.0"));
            note.addAttribute(new Attribute("pitchname", "x"));
            note.addAttribute(new Attribute("accidentals", "0.0"));
            note.addAttribute(new Attribute("octave", "3.0"));
            note.addAttribute(new Attribute("duration", "720.0"));
            score.appendChild(note);
        }
        msm.addPart(part);
        msm.setFile(new File("movement_fix_test.msm"));
        return msm;
    }

    static Mpm buildMpm(Double curvature, Double protraction, String controller) {
        Mpm mpm = Mpm.createMpm();
        Performance perf = Performance.createPerformance("perf", 720);
        mpm.addPerformance(perf);
        TempoMap tempoMap = TempoMap.createTempoMap();
        tempoMap.addTempo(0, "120", 0.25);
        perf.getGlobal().getDated().addMap(tempoMap);
        MovementMap movMap = MovementMap.createMovementMap();
        MovementData md = new MovementData();
        md.startDate = 0;
        md.position = 0.2;
        md.transitionTo = 0.9;
        md.controller = controller;
        md.curvature = curvature;      // null = element carries no attribute -> defaults
        md.protraction = protraction;
        movMap.addMovement(md);
        MovementData term = new MovementData();
        term.startDate = 2880;
        term.position = 0.9;
        term.transitionTo = 0.9;
        term.controller = controller;
        movMap.addMovement(term);
        MovementData term2 = new MovementData();
        term2.startDate = 5760;
        term2.position = 0.9;
        term2.transitionTo = 0.9;
        term2.controller = controller;
        movMap.addMovement(term2);
        perf.getGlobal().getDated().addMap(movMap);
        perf.addPart(Part.createPart("Piano", 1, 0, 0));
        return mpm;
    }

    static ArrayList<double[]> positions(Msm augmented) {
        ArrayList<double[]> out = new ArrayList<>();
        Elements parts = augmented.getRootElement().getChildElements("part");
        for (int pi = 0; pi < parts.size(); pi++) {
            Element posMap = parts.get(pi).getFirstChildElement("dated").getFirstChildElement("positionMap");
            if (posMap == null) continue;
            Elements evs = posMap.getChildElements("position");
            for (int i = 0; i < evs.size(); i++)
                out.add(new double[]{
                        Double.parseDouble(evs.get(i).getAttributeValue("date")),
                        Double.parseDouble(evs.get(i).getAttributeValue("value"))});
        }
        return out;
    }

    static String controllerOf(Msm augmented) {
        Elements parts = augmented.getRootElement().getChildElements("part");
        for (int pi = 0; pi < parts.size(); pi++) {
            Element posMap = parts.get(pi).getFirstChildElement("dated").getFirstChildElement("positionMap");
            if (posMap == null) continue;
            Elements evs = posMap.getChildElements("position");
            if (evs.size() > 0) return evs.get(0).getAttributeValue("controller");
        }
        return null;
    }
}
