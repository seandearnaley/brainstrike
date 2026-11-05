import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      coverage: { reportOnFailure: true },
      hookTimeout: 120_000,
      include: ['__tests__/**/*.test.ts'],
      testTimeout: 60_000,
    },
  })
);
