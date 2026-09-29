// Integration lane config for this package (BST-1214).
//
// Runs ONLY the env-sensitive `*.integration.test.*` files. Their pass/fail can
// depend on inputs turbo does NOT hash (here: a real PGlite/WASM Postgres), so
// they must never be replayed from a turbo cache: the root `test` task caches
// with `outputs: []`, meaning a cache HIT logs a green without executing
// anything. This lane is executed by the `test:integration` script, which turbo
// routes through the root UNCACHED `test:integration` task (turbo.jsonc,
// `cache: false`).
//
// It reuses the base config and REPLACES only what a real-database lane needs.
// The pure `test` script runs the complementary set
// (`vitest run --exclude '**/*.integration.test.*'`), so the two lanes
// partition the base suite by construction — no file can be orphaned. Base
// `test:coverage` keeps the base config's full include, so coverage still
// measures every file.
//
// Vitest's canonical test-extension suffix (?(c|m)[jt]s?(x)) rather than a bare
// `*`: a bare `*` would also match sibling artifacts such as
// __snapshots__/x.integration.test.ts.snap and try to LOAD them as test
// modules.
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // Coverage OFF in this lane, matching every other integration config in
    // the repo. Two reasons: the base config turns coverage on whenever
    // CI==='true', so the pure and integration lanes would race on the same
    // coverage temp directory under `turbo run test test:integration`; and
    // measuring global thresholds against this lane's single file is a
    // guaranteed non-zero exit. `test:coverage` measures the whole suite.
    coverage: { ...baseConfig.test?.coverage, enabled: false },
    // The base lane is a jsdom-ish React/testing-library setup (happy-dom).
    // This lane boots a real PGlite WASM Postgres and touches no DOM, so it
    // takes the same shape `packages/db` uses for its PGlite suites: `node`
    // plus `forks`, so each WASM instance is isolated in its own process and
    // the pool exits cleanly afterwards.
    environment: 'node',
    hookTimeout: 60_000,
    include: ['src/**/*.integration.test.?(c|m)[jt]s?(x)'],
    pool: 'forks',
    // No DOM/unit setup here: the base setup file is @testing-library/jest-dom
    // wiring, which has no DOM to attach to in this lane. The event-loop
    // watchdog still applies because this lane hosts real PGlite.
    setupFiles: ['@brainstrike/test-utils/vitest.event-loop-watchdog.setup'],
    // A real migrate() + PGlite boot is well past vitest's 5s default.
    testTimeout: 60_000,
  },
});
