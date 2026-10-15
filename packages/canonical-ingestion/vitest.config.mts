import path from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
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
    ],
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
  },
});
