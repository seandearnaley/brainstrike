import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      coverage: { reportOnFailure: true },
      // Coverage also runs the real-process integration suites, with the forked
      // indexers instrumented. On the 2-vCPU nightly runner, and under a local
      // throttle that reproduces it, their cases take up to 13.7 s (0.5-1.7 s
      // unthrottled), past Vitest's 5 s test and 10 s hook defaults. hookTimeout
      // and testTimeout both scale with TEST_TIMEOUT_MULTIPLIER.
      hookTimeout: getAdjustedTimeout('integration'),
      include: ['__tests__/**/*.test.ts'],
      testTimeout: getAdjustedTimeout('integration'),
    },
  })
);
