import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // Core tests run Node-only provider/tool code directly from source.
      ...['provider-request', 'provider-runtime', 'tool-runtime'].map((subpath) => ({
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
    hookTimeout: 120_000,
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    testTimeout: 60_000,
  },
});
