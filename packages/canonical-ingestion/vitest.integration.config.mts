import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

/** The Node integration lane: native-process fixtures. */
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      // Real native-process cases, on the same budget as indexer's integration lane.
      hookTimeout: getAdjustedTimeout('integration'),
      include: ['__tests__/**/*.integration.test.ts'],
      setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
      testTimeout: getAdjustedTimeout('integration'),
    },
  })
);
