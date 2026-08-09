import meico.mpm.elements.styles.defs.AccentuationPatternDef;

/**
 * Probe for the getAccentuationAt segment-end fix: pattern length 2880,
 * anchors at 0/720/1440/2160 (value 0, transition 0->1 each).
 * Buggy semantics at beatPosition 1.0: 1/2881 = 0.0003471017...
 * Fixed next-anchor semantics:         1/720  = 0.0013888888...
 */
public class AccentFixProbe {
    public static void main(String[] args) {
        AccentuationPatternDef def = AccentuationPatternDef.createAccentuationPatternDef("probe", 2880.0);
        def.addAccentuation(0.0, 0.0, 0.0, 1.0);
        def.addAccentuation(720.0, 0.0, 0.0, 1.0);
        def.addAccentuation(1440.0, 0.0, 0.0, 1.0);
        def.addAccentuation(2160.0, 0.0, 0.0, 1.0);
        double v = def.getAccentuationAt(1.0);
        System.out.println("accentuation at 1.0 = " + v + "  (velocity 100+v = " + (100.0 + v) + ")");
        System.out.println("last segment, at 2200.0 = " + def.getAccentuationAt(2200.0));
        boolean pass = Math.abs(v - (1.0 / 720.0)) < 1e-15;
        System.out.println(pass ? "ACCENT_FIX_PROBE_PASS" : "ACCENT_FIX_PROBE_FAIL");
        System.exit(pass ? 0 : 1);
    }
}
