import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';
import { HOOK_TIMEOUT_MS, TEST_TIMEOUT_MS } from './__tests__/fixtures/real-process-budget.ts';

export default defineConfig({
  resolve: {
    alias: [
      // Capability tests run Node-only provider/tool code directly from source.
      {
        find: /^@brainstrike\/agent$/,
        replacement: resolve(import.meta.dirname, '../agent/src/index.ts'),
      },
      ...['mcp-client', 'provider-request', 'provider-runtime', 'tool-runtime'].map((subpath) => ({
        find: new RegExp(`^@brainstrike/agent/${subpath}$`),
        replacement: resolve(import.meta.dirname, `../agent/src/${subpath}.ts`),
      })),
      ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
    ],
  },
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    fileParallelism: false,
    globals: true,
    // Both scale with the real-process step budget (BST-2157): hookTimeout covers
    // cleanup's sequential waits, testTimeout a real-bin test's bin calls.
    hookTimeout: HOOK_TIMEOUT_MS,
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    testTimeout: TEST_TIMEOUT_MS,
  },
});
