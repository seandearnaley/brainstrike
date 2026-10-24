import path from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

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

/** One project, `unit`, which runs in Node. */
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    projects: [
      {
        resolve: { alias: aliases },
        test: {
          environment: 'node',
          // The integration lane runs the built native-process fixtures (vitest.integration.config.mts).
          exclude: ['**/*.integration.test.ts', 'node_modules', 'dist'],
          globals: true,
          include: ['__tests__/**/*.test.ts'],
          name: 'unit',
          setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
        },
      },
    ],
    reporters: ['default', new LostTestFileReporter()],
  },
});
