// Manual model-download lane config for @brainstrike/embeddings.
//
// Runs ONLY the `*.models.test.*` files — the tests that download real ML
// models (~300MB+, multi-minute, real network). This lane is MANUAL: it is
// never invoked by CI (PR, push, scheduled, or coverage jobs) and is reachable
// only via the `test:models` script. The base vitest.config.mts EXCLUDES the
// `.models.test.*` suffix from every other lane (pure `test`, `test:integration`,
// `test:coverage`), so this config is the single place those files opt back in.
//
// It reuses the base config verbatim and REPLACES `test.include` (to the models
// suffix) and `test.exclude` (dropping the base's `**/*.models.test.*` entry so
// the files this lane targets are not filtered out; node_modules/dist stay
// excluded).
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

const baseTest = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    // Coverage stays OFF: model downloads are not a coverage signal and the
    // combined pure+integration `test:coverage` lane owns coverage.
    coverage: { ...(baseTest.coverage ?? {}), enabled: false },
    // Re-include the model-download suffix that the base config excludes:
    // derive from the base exclude list (dropping only the models-suffix
    // entry) so any future base exclusion is honored here automatically
    // instead of silently drifting (review nit on #1629).
    exclude: (baseTest.exclude ?? []).filter((pattern) => !pattern.includes('*.models.test.')),
    include: ['**/*.models.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
  },
});
