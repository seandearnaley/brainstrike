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
// not serialize; it relies on the default `forks` pool + adaptive
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
    // This include MIRRORS the pure lane's --exclude suffix (restricted to
    // real test-module extensions; see the note just above the glob), so the
    // two lanes partition the suffix by construction: a
    // file the pure lane excludes is always picked up here — it can never be
    // silently orphaned. (This package's BASE include is explicitly
    // {ts,tsx}-narrow, so a non-ts suffix file was never in the full suite —
    // here the mirror's value is that any suffix file that exists runs in
    // this lane instead of nowhere.) A suffix file outside the base include
    // runs here without counting toward coverage — the safe direction.
    // The base config's `exclude` (node_modules, dist) is inherited via the
    // spread above.
    // Vitest's canonical test-extension suffix (?(c|m)[jt]s?(x)) instead of a
    // bare `*`: still any real JS/TS extension (mts/cts/jsx/…), but a bare
    // `*` would also match sibling artifacts like
    // __snapshots__/x.integration.test.ts.snap and try to LOAD them as test
    // modules. The pure lane's `*` exclude harmlessly drops such files; this
    // lane must not attempt to run them.
    include: ['**/*.integration.test.?(c|m)[jt]s?(x)'],
  },
});
