/** Absolute locations of the two renderers. Nothing here is installed via npm. */

/** espressivo — the TypeScript port of meico, imported from its built facade. */
export const ESPRESSIVO = '/Users/nielspfeffer/Projects/meico-ts/dist/api/index.js';

/** The meico Java fork (movement + accentuation fixes landed, commit 1d662105). */
export const MEICO = '/Users/nielspfeffer/Projects/meico';

/** Classpath for `ml/java/RenderMpm`, the batch renderer of the Java fork. */
export const JAVA_CP = `/Users/nielspfeffer/Projects/mpmify/ml/java/out:${MEICO}/out/production/meico:${MEICO}/externals/*`;
