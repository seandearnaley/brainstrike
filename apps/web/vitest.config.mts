import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  optimizeDeps: {
    include: [
      '@brainstrike/hooks',
      '@brainstrike/ui',
    ],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: [
      'src/**/__tests__/**/*.{test,spec}.{ts,tsx}',
      'e2e/utils/**/__tests__/**/*.{test,spec,vitest}.{ts,tsx}',
    ],
    exclude: ['node_modules', 'dist'],
  },
  resolve: {
    alias: {
      '@brainstrike/types': resolve(__dirname, '../../packages/types/src'),
      '@brainstrike/hooks': resolve(__dirname, '../../packages/hooks/src'),
      '@brainstrike/ui': resolve(__dirname, '../../packages/ui/src'),
      '@brainstrike/utils': resolve(__dirname, '../../packages/utils/src'),
      '@brainstrike/file-explorer': resolve(__dirname, '../../packages/file-explorer/src'),
      '@brainstrike/file-explorer-hooks': resolve(__dirname, '../../packages/file-explorer-hooks/src'),
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
