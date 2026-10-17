import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // The host protocol and platform imports reach Node-only agent code; run it from source.
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
    exclude: ['node_modules', 'dist', 'tasks'],
    // An eval owns a real host process, its data root and its workspace.
    fileParallelism: false,
    globals: true,
    hookTimeout: 120_000,
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    testTimeout: 60_000,
  },
});
