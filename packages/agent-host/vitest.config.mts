import { resolve } from 'node:path';
import { getExpectPollTimeout } from '@brainstrike/test-utils/test-timeouts';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // Core tests run Node-only provider/tool code directly from source.
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
    // Polls of real hosts and child processes outlast Vitest's 1 s default
    // (BST-2181). The integration config spreads this test block; a call's own
    // options still win.
    expect: { poll: { timeout: getExpectPollTimeout() } },
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    hookTimeout: 120_000,
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    testTimeout: 60_000,
  },
});
