import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@brainstrike/indexer',
        replacement: fileURLToPath(new URL('./dist/index.js', import.meta.url)),
      },
      ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
    ],
  },
  test: {
    environment: 'node',
    include: ['__tests__/**/*.integration.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
  },
});
