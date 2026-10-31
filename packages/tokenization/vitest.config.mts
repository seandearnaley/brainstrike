import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      coverage: {
        exclude: ['src/__tests__/**', 'dist/**', 'node_modules/**'],
        include: ['src/**/*.{ts,tsx}'],
      },
      hookTimeout: 15_000,
      include: ['src/__tests__/**/*.test.{ts,tsx}'],
      setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
      testTimeout: 30_000,
    },
  })
);
