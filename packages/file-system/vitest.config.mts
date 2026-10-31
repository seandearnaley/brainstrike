import { coverageEnabled, sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      coverage: {
        enabled: coverageEnabled,
        exclude: [
          'src/**/__tests__/**',
          'src/**/*.test.ts',
          'src/**/*.test.tsx',
          '**/*.d.ts',
          '**/*.config.*',
          '**/dist/**',
        ],
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        provider: 'v8',
      },
      environment: 'happy-dom',
      include: ['src/__tests__/**/*.test.{ts,tsx}'],
    },
  })
);
