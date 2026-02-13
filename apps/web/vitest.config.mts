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
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
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
      '@brainstrike/agent': resolve(import.meta.dirname, '../../packages/agent/src'),
      '@brainstrike/agent/client': resolve(
        import.meta.dirname,
        '../../packages/agent/src/client.ts'
      ),
      '@brainstrike/types': resolve(import.meta.dirname, '../../packages/types/src'),
      '@brainstrike/hooks': resolve(import.meta.dirname, '../../packages/hooks/src'),
      '@brainstrike/ui': resolve(import.meta.dirname, '../../packages/ui/src'),
      '@brainstrike/utils': resolve(import.meta.dirname, '../../packages/utils/src'),
      '@brainstrike/file-explorer': resolve(
        import.meta.dirname,
        '../../packages/file-explorer/src'
      ),
      '@brainstrike/file-explorer-hooks': resolve(
        import.meta.dirname,
        '../../packages/file-explorer-hooks/src'
      ),
      '@brainstrike/file-explorer-ui': resolve(
        import.meta.dirname,
        '../../packages/file-explorer-ui/src'
      ),
      '@brainstrike/workers': resolve(import.meta.dirname, '../../packages/workers'),
      '@brainstrike/workers/file-content-worker': resolve(
        import.meta.dirname,
        '../../packages/workers/file-content-worker.ts'
      ),
    },
    preserveSymlinks: true,
  },
});
