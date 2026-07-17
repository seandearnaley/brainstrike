import { resolve } from 'node:path';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace deps from SOURCE, not built dist — including TRANSITIVE
    // ones (e.g. @brainstrike/types via utils src, which the old hand map
    // missed). See @brainstrike/test-utils/workspace-src-aliases (#1066/#1207).
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
  },
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['../../packages/test-utils/src/vitest.setup.ts'],
  },
});
