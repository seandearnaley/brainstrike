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
    // Coverage stays OFF in this lane. The base config enables coverage when
    // CI=true, and under `turbo run test test:integration` both lanes execute
    // CONCURRENTLY in the same package — two vitest processes sharing one
    // coverage/.tmp directory race and crash (observed in CI: "Something
    // removed the coverage directory ... Vitest created earlier"). Full-suite
    // coverage is owned by the single-process `test:coverage` script.
    coverage: { ...(baseTest.coverage ?? {}), enabled: false },
    // This include MIRRORS the pure lane's --exclude glob exactly (any
    // extension), so the two lanes partition the suffix by construction: a
    // file the pure lane excludes is always picked up here — it can never be
    // silently orphaned. (This package's BASE include is explicitly
    // {ts,tsx}-narrow, so a non-ts suffix file was never in the full suite —
    // here the mirror's value is that any suffix file that exists runs in
    // this lane instead of nowhere.) A suffix file outside the base include
    // runs here without counting toward coverage — the safe direction.
    include: ['**/*.integration.test.*'],
  },
});
