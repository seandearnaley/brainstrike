import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      include: ['__tests__/**/*.test.{ts,tsx}'],
      // The agent-color suites do O(n^2) colour-distance work: 0.3 s alone, past
      // Vitest's 5 s default on a host busy with parallel lanes.
      testTimeout: 30_000,
    },
  })
);
