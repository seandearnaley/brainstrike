import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@brainstrike\/utils\/(.*)$/,
        replacement: resolve(import.meta.dirname, '../utils/src/$1.ts'),
      },
      {
        find: '@brainstrike/utils',
        replacement: resolve(import.meta.dirname, '../utils/src'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.d.ts'],
    },
  },
});
