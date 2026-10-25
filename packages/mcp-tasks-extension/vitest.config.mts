import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist', '**/*.integration.test.ts'],
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
  },
});
