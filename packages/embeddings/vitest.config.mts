import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  resolve: {
    // Resolve workspace deps from SOURCE, not built dist — including
    // TRANSITIVE ones reached through the src-resolved graph (e.g.
    // @brainstrike/worker-runtime via embedding-worker src).
    // See @brainstrike/test-utils/workspace-src-aliases (incident #1066/#1207).
    alias: [...workspaceSrcAliases(resolve(__dirname, '..'))],
  },
  test: {
    coverage: {
      enabled: coverageEnabled,
      exclude: [
        '**/*.test.*',
        '**/__tests__/**',
        '**/dist/**',
        '**/node_modules/**',
        'src/cli/**',
        'bin/**',
      ],
      include: ['src/**/*.{ts,tsx}'],
      provider: 'v8',
      reporter: ['text', 'lcov', 'json'],
      reportsDirectory: './coverage',
    },
    environment: 'node',
    // Exclude node_modules/dist AND the manual model-download lane. The
    // `.models.test.*` suffix marks tests that download ML models (~300MB+,
    // multi-minute, real network) — they must NEVER run in the pure `test`
    // lane, the `test:integration` lane, or `test:coverage` (and therefore
    // never in CI). Excluding them HERE (filename-based, one place) covers
    // every base-config-derived lane; the manual `test:models` script
    // re-includes them via vitest.models.config.mts.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.models.test.*'],
    hookTimeout: 30_000,
    // Full `*.test.*` suffix breadth; `.models.test.*` stays excluded via `exclude` above.
    include: ['**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    // Use forks pool with parallelization for better performance
    pool: 'forks',
    reporters: ['default', new LostTestFileReporter()],
    testTimeout: 30_000,
  },
});
