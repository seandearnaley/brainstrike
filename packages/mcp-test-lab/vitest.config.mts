import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      coverage: { reportOnFailure: true },
      include: ['__tests__/**/*.test.ts'],
    },
  })
);
