// Integration lane config for @brainstrike/desktop.
//
// Runs ONLY the env-sensitive `*.integration.test.*` suffix lane. For desktop
// that is real PGlite (via wasmLoader.createPGlite), native/external binaries
// (node-pty, git, /bin/sh, ripgrep, oxc-parser N-API, secure-fs-native), a
// real stdio MCP child process, a loopback HTTP server, and several real-clock
// timeout/abort/benchmark/mtime assertions. Executed by the `test:integration`
// script (with --maxWorkers=1 --no-file-parallelism and this config's forks
// pool), which turbo routes through
// the root uncached `test:integration` task (turbo.jsonc, `cache: false`) so
// these env-sensitive lanes are never replayed from cache.
//
// It keeps the base source aliases after the explicit native artifact entries
// and REPLACES `test.include` with the
// integration suffix glob. The pure `test` script runs the complementary set
// (`vitest run --exclude "**/*.integration.test.*"`), so the two lanes
// partition the base suite by construction — no file can be orphaned. Base
// `test:coverage` keeps the base config's full include so coverage still
// measures every file in one process.
import { defineConfig } from 'vitest/config';
import baseConfig, {
  ELECTRON_RUNTIME_TESTS,
  NATIVE_PROCESS_ALIASES,
  UNDER_ELECTRON,
} from './vitest.config.mts';

const baseTest = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    // Native process proofs consume the built public entries, before source aliases.
    alias: [
      ...NATIVE_PROCESS_ALIASES,
      ...(Array.isArray(baseConfig.resolve?.alias) ? baseConfig.resolve.alias : []),
    ],
  },
  test: {
    ...baseTest,
    // Coverage stays OFF in this lane. The base config enables coverage when
    // CI=true, and under `turbo run test test:integration` both lanes execute
    // CONCURRENTLY in the same package — two vitest processes sharing one
    // coverage/.tmp directory race and crash (observed in Series A1 CI:
    // "Something removed the coverage directory ... Vitest created earlier").
    // Full-suite coverage is owned by the single-process `test:coverage` script.
    coverage: { ...(baseTest.coverage ?? {}), enabled: false },
    // This include MIRRORS the pure lane's --exclude suffix (restricted to
    // real test-module extensions; see the note just above the glob), so the
    // two lanes partition the suffix by construction: a
    // file the pure lane excludes is always picked up here — it can never be
    // silently orphaned. (Review finding on #1628: desktop's base config uses
    // vitest's DEFAULT include, which also matches .mts/.cts/.jsx — so under
    // the earlier {ts,tsx} narrowing a future .integration.test.mts would
    // have been in the full suite yet run in NEITHER lane.) A suffix file
    // outside the base include would run here without counting toward
    // coverage — the safe direction.
    // Vitest's canonical test-extension suffix (?(c|m)[jt]s?(x)) instead of a
    // bare `*`: still any real JS/TS extension (mts/cts/jsx/…), but a bare
    // `*` would also match sibling artifacts like
    // __snapshots__/x.integration.test.ts.snap and try to LOAD them as test
    // modules. The pure lane's `*` exclude harmlessly drops such files; this
    // lane must not attempt to run them.
    // Under Electron (scripts/run-integration.mjs) only the files that need it run.
    include: UNDER_ELECTRON ? ELECTRON_RUNTIME_TESTS : ['**/*.integration.test.?(c|m)[jt]s?(x)'],
    // The unit-only cold boot project does not belong in the native lane.
    pool: 'forks',
    projects: undefined,
  },
});
