import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      coverage: { reportOnFailure: true },
      include: ['src/__tests__/**/*.test.ts'],
      testTimeout: getAdjustedTimeout('integration'),
    },
  })
);
