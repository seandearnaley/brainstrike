import { resolve } from 'node:path';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // Capability tests run Node-only provider/tool code directly from source.
      {
        find: /^@brainstrike\/agent$/,
        replacement: resolve(import.meta.dirname, '../agent/src/index.ts'),
      },
      ...['mcp-client', 'hosted-web', 'provider-request', 'provider-runtime', 'tool-runtime'].map(
        (subpath) => ({
          find: new RegExp(`^@brainstrike/agent/${subpath}$`),
          replacement: resolve(import.meta.dirname, `../agent/src/${subpath}.ts`),
        })
      ),
      ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
    ],
  },
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    fileParallelism: false,
    globals: true,
    hookTimeout: 120_000,
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    // A real-bin test makes up to 15 bin calls: 5 s unthrottled, 48 s on the
    // hosted 2-vCPU coverage runner (BST-2157). It scales with each call's own
    // budget (__tests__/fixtures/real-bin.ts): 60 s, or 120 s on the nightly.
    testTimeout: getAdjustedTimeout('e2e'),
  },
});
