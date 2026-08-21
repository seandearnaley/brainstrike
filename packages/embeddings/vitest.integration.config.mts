// Integration lane config for @brainstrike/embeddings.
//
// Runs ONLY the env-sensitive `*.integration.test.*` files. For embeddings that
// is 14 files, all of which construct REAL PGlite via wasmLoader.createPGlite.
// NOTE: this lane is SERIALIZED — the `test:integration` script passes
// `--maxWorkers=1 --no-file-parallelism`, overriding the machine-relative
// `maxWorkers` this file inherits from the base config ('50%' on CI, '100%'
// locally). The serialization also leans on the base config's `pool: 'forks'`
// staying put: under `threads`, `--maxWorkers=1` would cap threads in ONE
// process and the ~1.9 GB heaps would share its address space. A worker peaks
// at ~1.9 GB RSS, and two of them plus a turbo-co-scheduled integration lane
// crashed workers on the CI host (BST-1072; see docs/agents/ci-quality.md,
// "The embeddings integration lane is serialized").
//
// The files' pass/fail can depend on inputs turbo does NOT hash (WASM/PGlite
// timing, CPU contention, the scheduler), so they must not be cacheable. Executed by the
// `test:integration` script, which turbo routes through the root uncached
// `test:integration` task (turbo.jsonc, `cache: false`) so these lanes are
// never replayed from cache. (The fake-timer foreground-embedding-gate suite is
// deliberately NOT here — its mocked-harness watchdog qualifies for the
// cacheable pure lane under the root turbo.jsonc boundary.)
//
// It reuses the base config verbatim and REPLACES only `test.include` with the
// integration suffix glob. The pure `test` script runs the complementary set
// (`vitest run --exclude '**/*.integration.test.*'`), so the two lanes
// partition the base suite by construction. The manual `.models.test.*`
// download lane is excluded by the base config's `exclude` (inherited here) and
// would not match this include anyway. Base `test:coverage` keeps the full
// include so coverage still measures pure + integration in one process.
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
    // This include MIRRORS the pure lane's --exclude glob exactly (any
    // extension), so the two lanes partition the suffix by construction: a file
    // the pure lane excludes is always picked up here — it can never be
    // silently orphaned. (This package's BASE include is explicit and broad —
    // `**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}` — so a `.integration.test.mts`
    // is already in the full suite AND, with this mirror, in this lane; the two
    // globs stay in lockstep by design.) A suffix file outside the base include
    // would run here without counting toward coverage — the safe direction.
    include: ['**/*.integration.test.*'],
  },
});
