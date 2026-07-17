// Integration lane config for @brainstrike/file-explorer-ui.
//
// Runs ONLY the env-sensitive `*.integration.test.{ts,tsx}` files — today the
// file-tree perf-budget suite, whose wall-clock averages depend on un-hashed
// CPU contention (it passes standalone but can exceed its budgets when every
// core is busy under a full parallel turbo run). Executed by the
// `test:integration` script, which turbo routes through the root uncached
// `test:integration` task (turbo.jsonc, `cache: false`) so a pass is never
// replayed from cache on a machine where it would fail live.
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
    include: ['src/**/__tests__/**/*.integration.test.{ts,tsx}'],
  },
});
