import path from 'node:path';
import { getAsyncUtilTimeout } from '@brainstrike/test-utils/test-timeouts';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';
import { createBrowserProject } from '../config/src/vitest-browser.ts';

const aliases = [
  // Coverage includes the real native-process integration fixtures.
  ...(process.argv.includes('--coverage')
    ? [
        {
          find: /^@brainstrike\/indexer$/,
          replacement: path.resolve(import.meta.dirname, '../indexer/dist/index.js'),
        },
      ]
    : []),
  ...workspaceSrcAliases(path.resolve(import.meta.dirname, '..')),
];

const browserProject = createBrowserProject({
  asyncUtilTimeout: getAsyncUtilTimeout(),
  setupFiles: ['@brainstrike/test-utils/vitest.browser.setup'],
  testPattern: '__tests__/**/*.browser.test.ts',
});

/**
 * Two projects. `unit` runs in Node. `browser` runs the host's browser entry
 * in Chromium, with the browser chunker, as the web's index worker does.
 */
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    projects: [
      {
        resolve: { alias: aliases },
        test: {
          environment: 'node',
          // The integration lane runs the built native-process fixtures (vitest.integration.config.mts).
          exclude: ['**/*.browser.test.ts', '**/*.integration.test.ts', 'node_modules', 'dist'],
          globals: true,
          include: ['__tests__/**/*.test.ts'],
          name: 'unit',
          setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
        },
      },
      {
        resolve: { alias: aliases },
        test: { ...browserProject.test, testTimeout: 60_000 },
      },
    ],
    reporters: ['default', new LostTestFileReporter()],
  },
});
