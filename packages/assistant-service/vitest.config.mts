import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

const agentDir = resolve(import.meta.dirname, '../agent');

export default defineConfig({
  resolve: {
    alias: [{ find: /^@brainstrike\/agent$/, replacement: resolve(agentDir, 'src/index.ts') }],
  },
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    fsModuleCache: true,
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
  },
});
