import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { getAdjustedTimeout } from '../../packages/test-utils/src/test-timeouts';

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: [path.resolve(__dirname, '../../packages')],
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['../../packages/test-utils/src/vitest.setup.ts', './src/__tests__/setup.ts'],
    globals: true,
    testTimeout: getAdjustedTimeout('uiComponent'),
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**', // Exclude Playwright e2e tests
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        '.vite/**',
        'dist/**',
        'src/__tests__/**',
        'e2e/**',
        '**/*.d.ts',
        '**/*.config.*',
        'src/main.ts', // Main process - tested separately
        'src/types/**',
        '**/*.test.ts',
        '**/*.test.tsx',
      ],
      thresholds: {
        lines: 80,
        functions: 70,
        branches: 70,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
      '@brainstrike/test-utils': path.resolve(__dirname, '../../packages/test-utils/src'),
      // Align with web tests: ensure workspace packages resolve consistently in Vitest
      '@brainstrike/config': path.resolve(__dirname, '../../packages/config/dist'),
      '@brainstrike/utils': path.resolve(__dirname, '../../packages/utils/src'),
      '@brainstrike/ui': path.resolve(__dirname, '../../packages/ui/src'),
      '@brainstrike/file-system': path.resolve(__dirname, '../../packages/file-system/src'),
      '@brainstrike/storage': path.resolve(__dirname, '../../packages/storage/src'),
      '@brainstrike/app-shell': path.resolve(__dirname, '../../packages/app-shell/src'),
      'file-saver': path.resolve(__dirname, './src/__tests__/mocks/file-saver.ts'),
    },
    preserveSymlinks: true,
  },
});
