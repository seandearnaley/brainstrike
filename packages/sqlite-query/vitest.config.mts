import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))] },
  test: {
    coverage: { reportOnFailure: true },
    environment: 'node',
    exclude: ['dist', 'node_modules'],
    include: ['src/__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    testTimeout: 15_000,
  },
});
