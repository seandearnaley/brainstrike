import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@brainstrike/types',
        replacement: resolve(import.meta.dirname, '../types/src/index.ts'),
      },
      {
        find: /^@brainstrike\/utils\/(.*)$/,
        replacement: resolve(import.meta.dirname, '../utils/src/$1.ts'),
      },
      {
        find: '@brainstrike/utils',
        replacement: resolve(import.meta.dirname, '../utils/src'),
      },
      {
        find: '@brainstrike/text-splitter/token-counting-heuristics',
        replacement: resolve(
          import.meta.dirname,
          '../text-splitter/src/token-counting-heuristics.ts'
        ),
      },
      {
        find: '@brainstrike/text-splitter/token-constants',
        replacement: resolve(import.meta.dirname, '../text-splitter/src/token-constants.ts'),
      },
      {
        find: '@brainstrike/text-splitter/token-utils-accurate-lite',
        replacement: resolve(
          import.meta.dirname,
          '../text-splitter/src/token-utils-accurate-lite.ts'
        ),
      },
      {
        find: /^@brainstrike\/text-splitter$/,
        replacement: resolve(import.meta.dirname, '../text-splitter/src/index.ts'),
      },
      {
        find: '@brainstrike/hooks',
        replacement: resolve(import.meta.dirname, '../hooks/src/index.ts'),
      },
      {
        find: '@brainstrike/worker-runtime',
        replacement: resolve(import.meta.dirname, '../worker-runtime/src/index.ts'),
      },
    ],
  },
  test: {
    coverage: {
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.d.ts'],
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/*.test.tsx', 'src/**/*.spec.tsx'],
    // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
    maxWorkers: process.env['CI'] ? '50%' : '100%',
  },
});
