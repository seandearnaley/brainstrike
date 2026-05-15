import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@brainstrike/text-splitter/chunking-core': path.resolve(
        __dirname,
        '../text-splitter/src/chunking-core.ts'
      ),
      '@brainstrike/text-splitter/token-utils-accurate-lite': path.resolve(
        __dirname,
        '../text-splitter/src/token-utils-accurate-lite.ts'
      ),
      '@brainstrike/text-splitter': path.resolve(__dirname, '../text-splitter/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['../../packages/test-utils/src/vitest.setup.ts'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    pool: 'threads',
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    coverage: {
      enabled: coverageEnabled,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/*.config.*', '**/dist/**', 'src/chunking.worker.ts'],
    },
  },
});
