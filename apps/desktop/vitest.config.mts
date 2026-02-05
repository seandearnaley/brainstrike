import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { getAdjustedTimeout } from '../../packages/test-utils/src/test-timeouts';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['../../packages/test-utils/src/vitest.setup.ts', './src/__tests__/setup.ts'],
    globals: true,
    testTimeout: getAdjustedTimeout('uiComponent'),
    // Use threads pool to avoid process forks (prevents EPERM kills in constrained sandboxes)
    pool: 'threads',
    // Vitest 4: use maxWorkers instead of poolOptions.threads.maxThreads
    maxWorkers: 8,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**', // Exclude Playwright e2e tests
    ],
    // Package-local coverage for reliability (root still consolidates)
    coverage: {
      enabled: coverageEnabled,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.*',
        '**/__tests__/**',
        '**/dist/**',
        '**/node_modules/**',
        '**/e2e/**',
        'src/main.ts',
        'src/preload.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
      '@brainstrike/agent/client': path.resolve(__dirname, '../../packages/agent/src/client.ts'),
      '@brainstrike/agent': path.resolve(__dirname, '../../packages/agent/src/index.ts'),
      '@brainstrike/utils': path.resolve(__dirname, '../../packages/utils/src/index.ts'),
      '@brainstrike/file-system': path.resolve(
        __dirname,
        '../../packages/file-system/src/index.ts'
      ),
      '@brainstrike/storage': path.resolve(__dirname, '../../packages/storage/src/index.ts'),
      '@brainstrike/types': path.resolve(__dirname, '../../packages/types/src/index.ts'),
      '@brainstrike/db': path.resolve(__dirname, '../../packages/db/src/index.ts'),
      '@brainstrike/embeddings': path.resolve(__dirname, '../../packages/embeddings/src/index.ts'),
      '@brainstrike/queue': path.resolve(__dirname, '../../packages/queue/src/index.ts'),
      '@brainstrike/embedding-worker': path.resolve(
        __dirname,
        '../../packages/embedding-worker/src/index.ts'
      ),
      '@brainstrike/test-utils': path.resolve(__dirname, '../../packages/test-utils/src'),
    },
  },
});
