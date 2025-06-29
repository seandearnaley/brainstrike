import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests import directly from Vítêst modules
    globals: false,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    alias: {
      '@brainstrike/storage': path.resolve(__dirname, '../storage/src/index.ts'),
      '@brainstrike/file-system': path.resolve(__dirname, '../file-system/src/index.ts'),
    },
  },
});
