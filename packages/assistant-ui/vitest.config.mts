import { resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';
import { createBrowserProject } from '../config/src/vitest-browser.ts';

const browserProject = createBrowserProject({
  testPattern: 'src/**/*.browser.test.{ts,tsx}',
});

const workspaceAliases = [
  {
    find: /^@brainstrike\/ui$/,
    replacement: resolve(import.meta.dirname, '../ui/src/index.ts'),
  },
  {
    // Asset export: the registry only aliases code subpaths, so without this
    // the browser suites' globals import resolves to ui's built dist copy.
    find: /^@brainstrike\/ui\/globals\.css$/,
    replacement: resolve(import.meta.dirname, '../ui/src/globals.css'),
  },
  ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
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
          setupFiles: ['@brainstrike/test-utils/vitest.setup'],
        },
      },
      {
        optimizeDeps: {
          include: [
            '@assistant-ui/react',
            '@tanstack/react-virtual',
            '@testing-library/jest-dom/vitest',
            '@testing-library/react',
            'react',
            'react-dom',
            'react-dom/client',
          ],
        },
        resolve: {
          alias: workspaceAliases,
          dedupe: ['react', 'react-dom'],
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
