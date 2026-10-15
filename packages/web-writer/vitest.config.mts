import { resolve } from 'node:path';
import { getAsyncUtilTimeout } from '@brainstrike/test-utils/test-timeouts';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';
import { createBrowserProject } from '../config/src/vitest-browser.ts';

const aliases = [
  // The corpus setup stores runs with Core's encoder, whose imports reach Node-only provider code.
  {
    find: /^@brainstrike\/agent$/,
    replacement: resolve(import.meta.dirname, '../agent/src/index.ts'),
  },
  ...['mcp-client', 'hosted-web', 'provider-request', 'provider-runtime', 'tool-runtime'].map(
    (subpath) => ({
      find: new RegExp(`^@brainstrike/agent/${subpath}$`),
      replacement: resolve(import.meta.dirname, `../agent/src/${subpath}.ts`),
    })
  ),
  ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
];

const browserProject = createBrowserProject({
  asyncUtilTimeout: getAsyncUtilTimeout(),
  setupFiles: ['@brainstrike/test-utils/vitest.browser.setup'],
  testPattern: 'src/**/*.browser.test.ts',
});

/**
 * Two projects. `unit` runs in Node: the composed worker's browser bundle.
 * `browser` runs in Chromium: the composed writer worker on OPFS, with the
 * derived index beside the state DB.
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
        // The engine resolves its wasm next to its own module; pre-bundling would move it.
        optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
        resolve: { alias: aliases },
        test: {
          ...browserProject.test,
          globalSetup: ['./src/__tests__/stored-host-corpus.global.ts'],
          hookTimeout: 60_000,
          testTimeout: 60_000,
        },
      },
    ],
    reporters: ['default', new LostTestFileReporter()],
  },
});
