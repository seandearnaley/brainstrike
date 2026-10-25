import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

/** One project, `unit`, which runs in Node. */
export default defineConfig({
  test: {
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    projects: [
      {
        test: {
          environment: 'node',
          // The integration lane runs the native-process fixtures (vitest.integration.config.mts).
          exclude: ['**/*.integration.test.ts', 'node_modules', 'dist'],
          globals: true,
          include: ['__tests__/**/*.test.ts'],
          name: 'unit',
          setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
        },
      },
    ],
    reporters: ['default', new LostTestFileReporter()],
  },
});
