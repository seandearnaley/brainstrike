// Integration lane config for @brainstrike/web.
//
// Runs ONLY the env-sensitive `*.integration.test.*` files (real PGlite /
// Mastra memory loop, wall-clock-sensitive render loops). It is executed by the
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
    // {ts,tsx} deliberately matches the base config's include breadth: an
    // integration file with any other extension would not be in the full suite
    // either, so widening only this glob would run files coverage never
    // measures. If the base include ever broadens, update this in the same
    // change.
    include: ['**/*.integration.test.{ts,tsx}'],
  },
});
