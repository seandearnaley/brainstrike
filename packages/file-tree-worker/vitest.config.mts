import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      coverage: {
        exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
        include: ['src/**/*.ts'],
        provider: 'v8',
        reporter: ['text', 'html', 'clover', 'json'],
      },
      include: ['src/**/*.test.ts'],
      passWithNoTests: true,
    },
  })
);
