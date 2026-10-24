import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { defineConfig } from 'vitest/config';
import config from './vitest.config.mts';

/** The Node integration lane: native-process fixtures. */
export default defineConfig({
  resolve: config.resolve,
  test: {
    environment: 'node',
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    // Real native-process cases, on the same budget as indexer's integration lane.
    hookTimeout: getAdjustedTimeout('integration'),
    include: ['__tests__/**/*.integration.test.ts'],
    reporters: config.test?.reporters,
    setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
    testTimeout: getAdjustedTimeout('integration'),
  },
});
