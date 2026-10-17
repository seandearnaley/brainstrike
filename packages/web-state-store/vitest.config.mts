import { resolve } from 'node:path';
import { getAsyncUtilTimeout } from '@brainstrike/test-utils/test-timeouts';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';
import { createBrowserProject } from '../config/src/vitest-browser.ts';

const aliases = workspaceSrcAliases(resolve(import.meta.dirname, '..'));

const browserProject = createBrowserProject({
  asyncUtilTimeout: getAsyncUtilTimeout(),
  setupFiles: ['@brainstrike/test-utils/vitest.browser.setup'],
  testPattern: 'src/**/*.browser.test.ts',
});

/**
 * Two projects. `unit` runs in Node: sqlite-wasm's Node build beside
 * better-sqlite3, so the wasm adapter is held to the desktop driver's
 * behavior on the same statements. `browser` runs in Chromium: OPFS, the Web
 * Lock, the BroadcastChannel and the writer worker itself.
 */
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    projects: [
      {
        resolve: { alias: aliases },
        test: {
          environment: 'node',
          exclude: ['**/*.browser.test.ts', 'node_modules', 'dist'],
          include: ['src/**/__tests__/**/*.test.ts'],
          name: 'unit',
          testTimeout: 30_000,
        },
      },
      {
        optimizeDeps: {
          // The engine resolves its wasm next to its own module; pre-bundling would move it.
          exclude: ['@sqlite.org/sqlite-wasm'],
          // Found only once a test loads utils' browser hashing, it would be optimized
          // mid-run, and Vite's reload would end that file's tester on a cold cache.
          include: ['@brainstrike/utils > @noble/hashes/sha2.js'],
        },
        resolve: { alias: aliases },
        test: {
          ...browserProject.test,
          hookTimeout: 60_000,
          testTimeout: 60_000,
        },
      },
    ],
    reporters: ['default', new LostTestFileReporter()],
  },
});
