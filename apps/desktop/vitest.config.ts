import path from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['../../packages/test-utils/src/vitest.setup.ts', './src/__tests__/setup.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'src/__tests__/',
        '**/*.d.ts',
        '**/*.config.*',
        'src/main.ts', // Main process - tested separately
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
      '@brainstrike/test-utils': path.resolve(__dirname, '../../packages/test-utils/src'),
    },
  },
}); 