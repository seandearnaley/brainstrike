// Integration lane config for @brainstrike/web.
//
// Runs the `*.integration.test.*` suffix lane. For web that is the
// env-sensitive web-mastra-storage test (real PGlite / Mastra memory loop)
// plus the pre-existing, fully-skipped app.integration.test.tsx, which keeps
// its suffix for convention only. The lane is executed by the
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
    // {ts,tsx} deliberately matches the base config's include breadth: an
    // integration file with any other extension would not be in the full suite
    // either, so widening only this glob would run files coverage never
    // measures. If the base include ever broadens, update this in the same
    // change.
    include: ['**/*.integration.test.{ts,tsx}'],
  },
});
