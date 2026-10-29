import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';
import { HOOK_TIMEOUT_MS, TEST_TIMEOUT_MS } from './__tests__/fixtures/real-process-budget.ts';

export default defineConfig({
  resolve: {
    alias: [
      // Capability tests run Node-only provider/tool code directly from source.
      {
        find: /^@brainstrike\/agent$/u,
        replacement: resolve(import.meta.dirname, '../agent/src/index.ts'),
      },
      ...['mcp-client', 'provider-request', 'provider-runtime', 'tool-runtime'].map((subpath) => ({
        find: new RegExp(`^@brainstrike/agent/${subpath}$`, 'u'),
        replacement: resolve(import.meta.dirname, `../agent/src/${subpath}.ts`),
      })),
    ],
  },
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    // Both scale with the real-process step budget (BST-2157): hookTimeout covers
    // cleanup's sequential waits, testTimeout a real-bin test's bin calls.
    hookTimeout: HOOK_TIMEOUT_MS,
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    // BST-2246: like the app's process entries, every test process makes the current
    // user the default owner first, so an elevated Windows run creates private
    // directories it owns.
    setupFiles: ['@brainstrike/secure-fs-native/default-owner'],
    testTimeout: TEST_TIMEOUT_MS,
  },
});
