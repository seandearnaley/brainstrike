import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // The host protocol and platform imports reach Node-only agent code; run it from source.
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
    exclude: ['node_modules', 'dist', 'tasks'],
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    hookTimeout: 120_000,
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    testTimeout: 60_000,
  },
});
