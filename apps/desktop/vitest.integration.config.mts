// Integration lane config for @brainstrike/desktop.
//
// Runs ONLY the env-sensitive `*.integration.test.*` suffix lane. For desktop
// that is real PGlite (via wasmLoader.createPGlite), native/external binaries
// (node-pty, git, /bin/sh, ripgrep, oxc-parser N-API, secure-fs-native), a
// real stdio MCP child process, a loopback HTTP server, and several real-clock
// timeout/abort/benchmark/mtime assertions. Executed by the `test:integration`
// script (with the same --pool=forks --maxWorkers=1 --no-file-parallelism
// serialization flags as the pure `test` script), which turbo routes through
// the root uncached `test:integration` task (turbo.jsonc, `cache: false`) so
// these env-sensitive lanes are never replayed from cache.
//
// It reuses the base config verbatim and REPLACES only `test.include` with the
// integration suffix glob. The pure `test` script runs the complementary set
// (`vitest run --exclude "**/*.integration.test.*"`), so the two lanes
// partition the base suite by construction — no file can be orphaned. Base
// `test:coverage` keeps the base config's full include so coverage still
// measures every file in one process.
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
    // coverage/.tmp directory race and crash (observed in Series A1 CI:
    // "Something removed the coverage directory ... Vitest created earlier").
    // Full-suite coverage is owned by the single-process `test:coverage` script.
    coverage: { ...(baseTest.coverage ?? {}), enabled: false },
    // This include MIRRORS the pure lane's --exclude glob exactly (any
    // extension), so the two lanes partition the suffix by construction: a
    // file the pure lane excludes is always picked up here — it can never be
    // silently orphaned. (Review finding on #1628: desktop's base config uses
    // vitest's DEFAULT include, which also matches .mts/.cts/.jsx — so under
    // the earlier {ts,tsx} narrowing a future .integration.test.mts would
    // have been in the full suite yet run in NEITHER lane.) A suffix file
    // outside the base include would run here without counting toward
    // coverage — the safe direction.
    include: ['**/*.integration.test.*'],
  },
});
