import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      include: ['src/__tests__/**/*.test.{ts,tsx}'],
      setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
    },
  })
);
