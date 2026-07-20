import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve workspace deps from SOURCE, not built dist — including TRANSITIVE
    // ones (e.g. @brainstrike/types via utils src, which the old hand map
    // missed). See @brainstrike/test-utils/workspace-src-aliases (#1066/#1207).
    alias: [...workspaceSrcAliases(path.resolve(__dirname, '..'))],
  },
  test: {
    coverage: {
      enabled: coverageEnabled,
      exclude: ['**/*.d.ts', '**/*.config.*', '**/dist/**', 'src/chunking.worker.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
    },
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    pool: 'threads',
    setupFiles: ['../../packages/test-utils/src/vitest.setup.ts'],
  },
});
