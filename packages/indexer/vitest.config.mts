import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: {
    alias: [
      // Coverage also runs real process cases; their entry needs emitted siblings.
      ...(process.argv.includes('--coverage')
        ? [
            {
              find: /^@brainstrike\/indexer$/,
              replacement: resolve(import.meta.dirname, './dist/index.js'),
            },
          ]
        : []),
      ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
    ],
  },
  test: {
    coverage: { reportOnFailure: true },
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
  },
});
