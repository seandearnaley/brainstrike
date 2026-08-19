import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  resolve: {
    // Resolve workspace deps (indexing-contract, utils) from SOURCE, not dist.
    // See @brainstrike/test-utils/workspace-src-aliases (incident #1066/#1207).
    alias: [...workspaceSrcAliases(resolve(__dirname, '..'))],
  },
  test: {
    clearMocks: true,
    environment: 'node',
    exclude: ['dist', 'node_modules'],
    globals: true,
    include: ['test/**/*.spec.ts', 'src/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    restoreMocks: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
  },
});
