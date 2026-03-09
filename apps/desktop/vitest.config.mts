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
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
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
      '@': path.resolve(import.meta.dirname, './src/renderer'),
      '@brainstrike/agent/client': path.resolve(
        import.meta.dirname,
        '../../packages/agent/src/client.ts'
      ),
      '@brainstrike/queue/browser': path.resolve(
        import.meta.dirname,
        '../../packages/queue/src/browser.ts'
      ),
      '@brainstrike/file-import/browser-queue-port': path.resolve(
        import.meta.dirname,
        '../../packages/file-import/src/browser-queue-port.ts'
      ),
      '@brainstrike/file-import/chunking-worker-context': path.resolve(
        import.meta.dirname,
        '../../packages/file-import/src/chunking-worker-context.tsx'
      ),
      '@brainstrike/file-import/enhanced-import': path.resolve(
        import.meta.dirname,
        '../../packages/file-import/src/enhanced-import.ts'
      ),
      '@brainstrike/test-utils': path.resolve(import.meta.dirname, '../../packages/test-utils/src'),
    },
  },
});
