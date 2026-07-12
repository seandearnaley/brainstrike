// Integration lane config for @brainstrike/file-import.
//
// Runs ONLY the env-sensitive `*.integration.test.*` files (real PGlite via
// wasmLoader.createPGlite). Executed by the `test:integration` script, which
// turbo routes through the root uncached `test:integration` task (turbo.jsonc,
// `cache: false`) so these WASM-PGlite lanes are never replayed from cache.
//
// It reuses the base config verbatim and REPLACES only `test.include` with the
// integration suffix glob. The pure `test` script runs the complementary set
// (`vitest run --exclude '**/*.integration.test.*'`), so the two lanes partition
// the base suite by construction. Base `test:coverage` keeps the full include so
// coverage still measures every file.
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

const baseTest = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    include: ['**/*.integration.test.{ts,tsx}'],
  },
});
