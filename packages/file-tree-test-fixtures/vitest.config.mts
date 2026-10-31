import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      environment: 'happy-dom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    },
  })
);
