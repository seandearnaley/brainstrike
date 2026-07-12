// Integration lane config for @brainstrike/app-shell.
//
// Runs ONLY the env-sensitive `*.integration.test.{ts,tsx}` files: the
// real-PGlite-via-`wasmLoader.createPGlite` repository/benchmark suites (the
// workspace-index benchmark and the 108k-chunk collection-sync-import-large
// wall-clock lanes) plus the timing-sensitive stale-loop / retry-contract
// component tests that assert against un-faked `setTimeout` / `waitFor` windows.
// Their pass/fail can depend on un-hashed CPU contention and wall-clock timing,
// so they must never be replayed from a turbo cache. Executed by the
// `test:integration` script, which turbo routes through the root uncached
// `test:integration` task (turbo.jsonc, `cache: false`).
//
// It reuses the base config verbatim and REPLACES only `test.include` with the
// integration suffix glob. The pure `test` script runs the complementary set
// (`vitest run --exclude '**/*.integration.test.*'`), so the two lanes partition
// the base suite by construction — no file can be orphaned. Base `test:coverage`
// keeps the base config's full include so coverage still measures every file.
// Both lanes keep `--no-file-parallelism` (serialization is held constant across
// the split; only caching changes) while retaining the base `pool: 'threads'`
// and adaptive `maxWorkers`.
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

const baseTest = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    // Coverage stays OFF in this lane. The base config enables coverage when
    // CI=true, and under `turbo run test test:integration` both lanes execute
    // CONCURRENTLY in the same package — two vitest processes sharing one
    // coverage/.tmp directory race and crash (observed in CI: "Something
    // removed the coverage directory ... Vitest created earlier"). Full-suite
    // coverage is owned by the single-process `test:coverage` script.
    coverage: { ...(baseTest.coverage ?? {}), enabled: false },
    // {ts,tsx} deliberately matches the base config's include breadth: an
    // integration file with any other extension would not be in the full suite
    // either, so widening only this glob would run files coverage never
    // measures. The base config's `exclude` (node_modules, dist) is inherited
    // via the spread above. If the base include ever broadens, update this in
    // the same change.
    include: ['**/*.integration.test.{ts,tsx}'],
  },
});
