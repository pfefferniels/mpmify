import { fileURLToPath } from 'node:url';

/**
 * `scripts/bake/*` and mpm-desk both import mpmify by package name. The alias lets the bake
 * and the tests run against the working tree rather than a published build.
 *
 * Typed structurally rather than through vite's `defineConfig`, so the config file needs no
 * dependency the package does not already have.
 */
export default {
  resolve: {
    alias: {
      mpmify: fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
};
