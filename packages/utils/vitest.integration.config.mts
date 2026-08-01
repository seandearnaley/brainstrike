// Integration lane config for this package (BST-1006).
//
// Runs ONLY the env-sensitive `*.integration.test.*` files. Their pass/fail can
// depend on inputs turbo does NOT hash (real PGlite/WASM, native binaries,
// wall-clock timing), so they must never be replayed from a turbo cache: the
// root `test` task caches with `outputs: []`, meaning a cache HIT logs a green
// without executing anything. This lane is executed by the `test:integration`
// script, which turbo routes through the root UNCACHED `test:integration` task
// (turbo.jsonc, `cache: false`).
//
// It reuses the base config verbatim and REPLACES only `test.include` with the
// integration glob. The pure `test` script runs the complementary set
// (`vitest run --exclude '**/*.integration.test.*'`), so the two lanes
// partition the base suite by construction — no file can be orphaned. Base
// `test:coverage` keeps the base config's full include, so coverage still
// measures every file.
//
// Vitest's canonical test-extension suffix (?(c|m)[jt]s?(x)) rather than a bare
// `*`: a bare `*` would also match sibling artifacts such as
// __snapshots__/x.integration.test.ts.snap and try to LOAD them as test
// modules.
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['**/*.integration.test.?(c|m)[jt]s?(x)'],
  },
});
