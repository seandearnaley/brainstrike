import { resolve } from 'node:path';
import { getAsyncUtilTimeout } from '@brainstrike/test-utils/test-timeouts';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import type { BrowserCommand, BrowserConfigOptions } from 'vitest/node';
import { createBrowserProject } from '../config/src/vitest-browser.ts';
import { measureCommittedProduction } from './committed-production-command.mts';

const emulateReducedMotion: BrowserCommand<[options: { enabled: boolean | null }]> = async (
  { page },
  { enabled }
): Promise<void> => {
  await page.emulateMedia({
    reducedMotion: enabled === null ? null : enabled ? 'reduce' : 'no-preference',
  });
};

const browserProject = createBrowserProject({
  // Carries TEST_TIMEOUT_MULTIPLIER into the browser page, where `process`
  // does not exist and @testing-library/dom would otherwise sit on its
  // unscalable 1s waitFor default (BST-1299).
  asyncUtilTimeout: getAsyncUtilTimeout(),
  // Owned by the caller, not defaulted inside @brainstrike/config: that
  // package is `tooling` and cannot depend on @brainstrike/test-utils, and a
  // factory default would be silently droppable by the `...browserProject.test`
  // spread below.
  setupFiles: ['@brainstrike/test-utils/vitest.browser.setup'],
  testPattern: 'src/**/*.browser.test.{ts,tsx}',
});

const sharedBrowserOptions: BrowserConfigOptions = browserProject.test.browser;

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
  plugins: [tailwindcss()],
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
          exclude: [
            'node_modules',
            'dist',
            '**/*.browser.test.{ts,tsx}',
            '**/*.compiled.test.{ts,tsx}',
          ],
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
        // The shipped renderer runs the React Compiler (apps/desktop/vite.config.mts),
        // which memoizes on what a body reads and drops unread manual dependencies.
        // Suites here compile the source the same way, so they can see that.
        plugins: [react({ compiler: { compilationMode: 'infer' } })],
        resolve: {
          alias: workspaceAliases,
        },
        test: {
          environment: 'happy-dom',
          globals: true,
          include: ['src/**/*.compiled.test.{ts,tsx}'],
          // Same as `unit`: one run of both projects needs one maxWorkers per groupOrder.
          maxWorkers: process.env['CI'] ? '50%' : '100%',
          name: 'compiled',
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
            // The browser setup file imports @testing-library/dom DIRECTLY, a
            // specifier no suite here writes. Listed so it is pre-bundled with
            // (not discovered after, and re-optimized alongside) the copy
            // @testing-library/react resolves — a split there would apply the
            // async-util budget to an instance no `waitFor` reads.
            '@testing-library/dom',
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
          browser: {
            ...sharedBrowserOptions,
            commands: {
              ...sharedBrowserOptions.commands,
              emulateReducedMotion,
              measureCommittedProduction,
            },
          },
          globals: true,
          sequence: {
            groupOrder: 1,
          },
        },
      },
    ],
    reporters: ['default', new LostTestFileReporter()],
  },
});
