import { resolve } from 'node:path';
import { getAsyncUtilTimeout } from '@brainstrike/test-utils/test-timeouts';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { createBrowserProject } from '../config/src/vitest-browser.ts';

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

const workspaceAliases = [
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
    find: '@brainstrike/utils/quick-filter-utils',
    replacement: resolve(import.meta.dirname, '../utils/src/quick-filter-utils.ts'),
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
  // Registry fills gaps (e.g. @brainstrike/context-actions, executed unmocked by
  // action-context-menu.test.tsx). The hand-rolled entries above win by
  // first-match ordering. See workspace-src-aliases (incident #1066/#1207).
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
        // Pre-bundle the React-dependent deps the browser suite mounts. Without
        // this they are discovered mid-run and re-optimized into a SECOND
        // dependency graph with its own React copy — the renderer then hits
        // "Cannot read properties of null (reading 'useReducer')" on first
        // mount. (@assistant-ui/react left this list with the BST-981 panel
        // extraction — it is no longer a ui dependency.)
        optimizeDeps: {
          include: [
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
        // Real Tailwind for browser suites that import a `*.browser.css` entry,
        // so painted geometry is asserted against the classes the app emits.
        // Browser project only: happy-dom unit suites never need it.
        plugins: [tailwindcss()],
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
    reporters: ['default', new LostTestFileReporter()],
  },
});
