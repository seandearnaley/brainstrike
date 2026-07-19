// Integration lane config for @brainstrike/file-system.
//
// Runs ONLY the env-sensitive `*.integration.test.ts` files — today the
// @parcel/watcher native-binding proof (BST-568), which loads a real native
// module and depends on wall-clock OS event delivery. Executed by the
// `test:integration` script, which turbo routes through the root uncached
// `test:integration` task so a pass is never replayed from cache on a machine
// where it would fail live (e.g. a missing platform prebuild).
//
// It reuses the base config verbatim and REPLACES only `test.include` with the
// integration suffix glob. The pure `test` script runs the complementary set
// (`vitest run --exclude '**/*.integration.test.*'`), so the two lanes
// partition the base suite by construction — no file can be orphaned.
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

const baseTest = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    include: ['src/__tests__/**/*.integration.test.{ts,tsx}'],
  },
});
