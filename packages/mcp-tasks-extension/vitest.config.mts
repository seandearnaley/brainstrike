import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      exclude: ['node_modules', 'dist', '**/*.integration.test.ts'],
      include: ['__tests__/**/*.test.ts'],
    },
  })
);
