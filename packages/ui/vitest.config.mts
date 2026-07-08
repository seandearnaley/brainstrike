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
          coverage: {
            exclude: [
              '**/__tests__/**',
              '**/*.browser.test.{ts,tsx}',
              '**/*.d.ts',
              '**/types.ts',
              '**/types/**',
              '**/dist/**',
              '**/index.ts',
            ],
            include: ['src/**/*.{ts,tsx}'],
          },
          environment: 'happy-dom',
          exclude: ['node_modules', 'dist', '**/*.browser.test.{ts,tsx}'],
          globals: true,
          include: ['src/__tests__/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.test.{ts,tsx}'],
          maxWorkers: process.env['CI'] ? '50%' : '100%',
          name: 'unit',
          pool: 'threads',
          sequence: {
            groupOrder: 0,
          },
          server: {
            deps: {
              // react-shiki@0.10+ ships a top-level `import './style.css'` side effect in
              // its shared component chunk; Vitest externalizes node_modules by default,
              // which hands that CSS import to Node's native ESM loader (no CSS support)
              // instead of Vite's transform pipeline. Inlining forces Vite to handle it.
              inline: ['react-shiki'],
            },
          },
          setupFiles: ['@brainstrike/test-utils/vitest.setup'],
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
