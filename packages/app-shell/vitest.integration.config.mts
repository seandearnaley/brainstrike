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
// Both app-shell lanes run with vitest defaults — neither the `test` nor the
// `test:integration` script passes `--no-file-parallelism` (this package does
// not serialize; it relies on the base `pool: 'threads'` + adaptive
// `maxWorkers`). Serialization is held constant across the split: the split
// changes only caching, not the runner flags.
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

const baseTest = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    // Coverage stays OFF in this lane. app-shell's base config declares NO
    // coverage key at all (coverage is consolidated at the root
    // vitest.config.mts and driven here only by the `--coverage` CLI flag on the
    // single-process `test:coverage` script), so this `enabled: false` is not
    // fixing an active race in THIS package — it is defensive consistency with
    // the repo-wide integration-lane pattern, keeping the pin in place should a
    // future config move ever introduce a base coverage key. Full-suite coverage
    // remains owned by `test:coverage`.
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
