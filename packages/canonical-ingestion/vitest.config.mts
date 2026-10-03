import path from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: [...workspaceSrcAliases(path.resolve(import.meta.dirname, '..'))] },
  test: {
    environment: 'node',
    globals: true,
    include: ['__tests__/**/*.test.ts'],
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
  },
});
