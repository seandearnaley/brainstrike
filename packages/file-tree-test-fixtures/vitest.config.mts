import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
  },
  test: {
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
  },
});
