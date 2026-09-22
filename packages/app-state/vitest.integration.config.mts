// Integration lane config for @brainstrike/app-state.
//
// Runs ONLY the env-sensitive `*.integration.test.*` files (real PGlite via
// `@brainstrike/db`'s production `createEnginePglite` + `migrate` entry
// points — see model-registry-store.integration.test.ts). Executed by the
// `test:integration` script, which turbo routes through the root uncached
// `test:integration` task (turbo.jsonc, `cache: false`) so this WASM-PGlite
// lane is never replayed from a stale cache hit.
//
// It reuses the base config verbatim and REPLACES only `test.include` with
// the integration suffix glob. The pure `test` script runs the complementary
// set (`vitest run --exclude '**/*.integration.test.*'`), so the two lanes
// partition the base suite by construction (guarded by
// scripts/__tests__/integration-suffix-partition.test.mjs) — no file can be
// orphaned into neither lane.
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

const baseTest = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    // Coverage stays OFF in this lane: under `turbo run test test:integration`
    // both lanes can execute concurrently in the same package, and two vitest
    // processes sharing one coverage/.tmp directory race (observed elsewhere
    // in this repo as "Something removed the coverage directory ... Vitest
    // created earlier"). Full-suite coverage stays owned by `test:coverage`.
    coverage: { ...(baseTest.coverage ?? {}), enabled: false },
    // Mirrors the pure lane's --exclude suffix so the two lanes partition the
    // suite by construction: a file the pure lane excludes always runs here.
    // The canonical test-extension suffix (not a bare `*`) so sibling
    // artifacts (e.g. __snapshots__/x.integration.test.ts.snap) are not
    // loaded as test modules.
    include: ['src/__tests__/**/*.integration.test.?(c|m)[jt]s?(x)'],
  },
});
