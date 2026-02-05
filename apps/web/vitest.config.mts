import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

export default defineConfig({
  optimizeDeps: {
    include: ['@brainstrike/hooks', '@brainstrike/ui'],
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    testTimeout: 15_000, // uiComponent timeout (getAdjustedTimeout not available in build context)
    include: [
      'src/**/__tests__/**/*.test.{ts,tsx}',
      // E2E utility unit tests use .vitest.ts extension to avoid Playwright extension conflict
      'e2e/utils/__tests__/**/*.vitest.ts',
    ],
    exclude: ['node_modules', 'dist'],
    // Use threads pool with increased parallelization for better CPU utilization
    pool: 'threads',
    // Vitest 4: use maxWorkers instead of poolOptions.threads.maxThreads
    maxWorkers: 8,
    // Ensure coverage only counts actual source files to avoid skew from configs/e2e utils.
    coverage: {
      enabled: coverageEnabled,
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'lcov', 'json'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.*',
        '**/__tests__/**',
        '**/*.d.ts',
        '**/dist/**',
        '**/node_modules/**',
        '**/*.config.*',
        '**/vite.config.*',
        '**/vitest.config.*',
        '**/playwright.config.*',
        'e2e/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@brainstrike/agent': resolve(__dirname, '../../packages/agent/src'),
      '@brainstrike/agent/client': resolve(__dirname, '../../packages/agent/src/client.ts'),
      '@brainstrike/types': resolve(__dirname, '../../packages/types/src'),
      '@brainstrike/hooks': resolve(__dirname, '../../packages/hooks/src'),
      '@brainstrike/ui': resolve(__dirname, '../../packages/ui/src'),
      '@brainstrike/utils': resolve(__dirname, '../../packages/utils/src'),
      '@brainstrike/file-explorer': resolve(__dirname, '../../packages/file-explorer/src'),
      '@brainstrike/file-explorer-hooks': resolve(
        __dirname,
        '../../packages/file-explorer-hooks/src'
      ),
      '@brainstrike/file-explorer-ui': resolve(__dirname, '../../packages/file-explorer-ui/src'),
      '@brainstrike/workers': resolve(__dirname, '../../packages/workers'),
      '@brainstrike/workers/file-content-worker': resolve(
        __dirname,
        '../../packages/workers/file-content-worker.ts'
      ),
    },
    preserveSymlinks: true,
  },
});
