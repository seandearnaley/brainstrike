import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { createBrowserProject } from '../config/src/vitest-browser.ts';

const browserProject = createBrowserProject({
  testPattern: 'src/**/*.browser.test.{ts,tsx}',
});

const workspaceAliases = [
  {
    find: /^@brainstrike\/assistant-contract\/(.*)$/,
    replacement: resolve(import.meta.dirname, '../assistant-contract/src/$1.ts'),
  },
  {
    find: '@brainstrike/assistant-contract',
    replacement: resolve(import.meta.dirname, '../assistant-contract/src/index.ts'),
  },
  {
    find: /^@brainstrike\/utils\/(.*)$/,
    replacement: resolve(import.meta.dirname, '../utils/src/$1.ts'),
  },
  {
    find: '@brainstrike/utils/create-debounce',
    replacement: resolve(import.meta.dirname, '../utils/src/create-debounce.ts'),
  },
  {
    find: '@brainstrike/utils/collator',
    replacement: resolve(import.meta.dirname, '../utils/src/collator.ts'),
  },
  {
    find: '@brainstrike/utils/env-utils',
    replacement: resolve(import.meta.dirname, '../utils/src/env-utils.ts'),
  },
  {
    find: '@brainstrike/utils/file-utils',
    replacement: resolve(import.meta.dirname, '../utils/src/file-utils.ts'),
  },
  {
    find: '@brainstrike/utils/filter-utils',
    replacement: resolve(import.meta.dirname, '../utils/src/filter-utils.ts'),
  },
  {
    find: '@brainstrike/utils/logger',
    replacement: resolve(import.meta.dirname, '../utils/src/logger.ts'),
  },
  {
    find: '@brainstrike/utils/quick-filter-utils',
    replacement: resolve(import.meta.dirname, '../utils/src/quick-filter-utils.ts'),
  },
  {
    find: '@brainstrike/utils/report-generator',
    replacement: resolve(import.meta.dirname, '../utils/src/report-generator.ts'),
  },
  {
    find: '@brainstrike/utils/safe-storage',
    replacement: resolve(import.meta.dirname, '../utils/src/safe-storage.ts'),
  },
  {
    find: '@brainstrike/hooks',
    replacement: resolve(import.meta.dirname, '../hooks/src/index.ts'),
  },
  {
    find: '@brainstrike/ui',
    replacement: resolve(import.meta.dirname, './src/index.ts'),
  },
  {
    find: '@brainstrike/utils',
    replacement: resolve(import.meta.dirname, '../utils/src'),
  },
];

export default defineConfig({
  optimizeDeps: {
    include: ['@testing-library/jest-dom/vitest'],
  },
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    projects: [
      {
        resolve: {
          alias: workspaceAliases,
        },
        test: {
          name: 'unit',
          environment: 'happy-dom',
          globals: true,
          setupFiles: ['@brainstrike/test-utils/vitest.setup'],
          include: ['src/__tests__/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.test.{ts,tsx}'],
          exclude: ['node_modules', 'dist', '**/*.browser.test.{ts,tsx}'],
          pool: 'threads',
          maxWorkers: process.env['CI'] ? '50%' : '100%',
          sequence: {
            groupOrder: 0,
          },
          coverage: {
            include: ['src/**/*.{ts,tsx}'],
            exclude: [
              '**/__tests__/**',
              '**/*.browser.test.{ts,tsx}',
              '**/*.d.ts',
              '**/types.ts',
              '**/types/**',
              '**/dist/**',
              '**/index.ts',
            ],
          },
        },
      },
      {
        resolve: {
          alias: workspaceAliases,
        },
        test: {
          ...browserProject.test,
          globals: true,
          sequence: {
            groupOrder: 1,
          },
        },
      },
    ],
  },
});
