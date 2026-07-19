// Integration lane config for @brainstrike/web.
//
// Runs the `*.integration.test.*` suffix lane. The Hosted Web assistant is
// stateless and no longer boots a server-side PGlite workflow store, so the
// only current Web member is the pre-existing, fully-skipped
// app.integration.test.tsx, which keeps its suffix for convention only. The lane is executed by the
// `test:integration` script, which turbo routes through the root uncached
// `test:integration` task (turbo.jsonc, `cache: false`) so these lanes are
// never replayed from cache.
//
// It reuses the base config verbatim and REPLACES only `test.include` with the
// integration suffix glob. The pure `test` script runs the complementary set
// (`vitest run --exclude '**/*.integration.test.*'`), so the two lanes partition
// the base suite by construction — no file can be orphaned. Base `test:coverage`
// keeps the base config's full include so coverage still measures every file.
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
    // This include MIRRORS the pure lane's --exclude suffix (restricted to
    // real test-module extensions; see the note just above the glob), so the
    // two lanes partition the suffix by construction: a
    // file the pure lane excludes is always picked up here — it can never be
    // silently orphaned. (This package's BASE include is explicitly
    // {ts,tsx}-narrow, so a non-ts suffix file was never in the full suite —
    // here the mirror's value is that any suffix file that exists runs in
    // this lane instead of nowhere.) A suffix file outside the base include
    // runs here without counting toward coverage — the safe direction.
    // Vitest's canonical test-extension suffix (?(c|m)[jt]s?(x)) instead of a
    // bare `*`: still any real JS/TS extension (mts/cts/jsx/…), but a bare
    // `*` would also match sibling artifacts like
    // __snapshots__/x.integration.test.ts.snap and try to LOAD them as test
    // modules. The pure lane's `*` exclude harmlessly drops such files; this
    // lane must not attempt to run them.
    include: ['**/*.integration.test.?(c|m)[jt]s?(x)'],
  },
});
