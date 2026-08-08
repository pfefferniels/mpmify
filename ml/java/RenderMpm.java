import meico.msm.Msm;
import meico.mpm.Mpm;
import meico.mpm.elements.Performance;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.util.Locale;

/**
 * Render an MPM performance onto an MSM score with meico and write the augmented MSM.
 *
 * This is the export-side counterpart of SampleAndRender: it takes an MPM file that was
 * produced OUTSIDE of meico (e.g. by ml/python/dsl_to_mpm.py from model output) and proves
 * that meico's parser + renderer produce exactly the same performance as the in-memory
 * object graph the generator used.
 *
 * Usage: RenderMpm &lt;in.msm&gt; &lt;in.mpm&gt; &lt;out_augmented.msm&gt; [performanceIndex]
 *        RenderMpm --batch &lt;manifest.tsv&gt;
 *
 * The batch manifest has one job per line, tab-separated:
 *     in.msm \t in.mpm \t out_augmented.msm [\t performanceIndex]
 * Blank lines and lines starting with '#' are ignored. All jobs run in ONE JVM, which is
 * what makes larger stress sweeps affordable (JVM startup dominates a single render:
 * ~4-6 s startup vs ~3 ms rendering for a mid-size piece).
 *
 * Exit codes: 0 ok, 1 usage, 2 no performance in the MPM, 3 rendering returned null,
 *             4 at least one batch job failed (per-job diagnostics on stderr).
 */
public class RenderMpm {

    public static void main(String[] args) throws Exception {
        Locale.setDefault(Locale.US);

        if (args.length >= 2 && args[0].equals("--batch")) {
            System.exit(batch(new File(args[1])));
            return;
        }

        if (args.length < 3) {
            System.err.println("Usage: RenderMpm <in.msm> <in.mpm> <out_augmented.msm> [performanceIndex]");
            System.err.println("       RenderMpm --batch <manifest.tsv>");
            System.exit(1);
        }
        int rc = render(new File(args[0]), new File(args[1]), new File(args[2]),
                        args.length > 3 ? Integer.parseInt(args[3]) : 0);
        if (rc == 0)
            System.out.println("RenderMpm: wrote " + args[2]);
        System.exit(rc);
    }

    /** @return 0 ok, 2 no performance, 3 perform() returned null */
    private static int render(File msmFile, File mpmFile, File outFile, int perfIndex) throws Exception {
        Msm msm = new Msm(msmFile);
        Mpm mpm = new Mpm(mpmFile);

        if (mpm.getAllPerformances().isEmpty()) {
            System.err.println("RenderMpm: no performance found in " + mpmFile);
            return 2;
        }
        Performance perf = mpm.getPerformance(perfIndex);
        if (perf == null) {
            System.err.println("RenderMpm: no performance at index " + perfIndex + " in " + mpmFile);
            return 2;
        }

        Msm augmented = perf.perform(msm);
        if (augmented == null) {
            System.err.println("RenderMpm: perform() returned null");
            return 3;
        }

        if (outFile.getParentFile() != null) outFile.getParentFile().mkdirs();
        try (FileWriter fw = new FileWriter(outFile)) {
            fw.write(augmented.toXML());
        }
        return 0;
    }

    /** Render every job of the manifest in this one JVM. @return 0 if all succeeded, else 4. */
    private static int batch(File manifest) throws Exception {
        int jobs = 0, failed = 0;
        try (BufferedReader r = new BufferedReader(new FileReader(manifest))) {
            String line;
            while ((line = r.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty() || line.startsWith("#")) continue;
                String[] f = line.split("\t");
                if (f.length < 3) {
                    System.err.println("RenderMpm batch: malformed line: " + line);
                    failed++;
                    continue;
                }
                jobs++;
                int rc = render(new File(f[0]), new File(f[1]), new File(f[2]),
                                f.length > 3 ? Integer.parseInt(f[3]) : 0);
                if (rc != 0) {
                    System.err.println("RenderMpm batch: job " + jobs + " failed (rc=" + rc + "): " + line);
                    failed++;
                } else {
                    System.out.println("OK\t" + f[2]);
                }
            }
        }
        System.out.println("RenderMpm batch: " + jobs + " jobs, " + failed + " failed");
        return failed == 0 ? 0 : 4;
    }
}
