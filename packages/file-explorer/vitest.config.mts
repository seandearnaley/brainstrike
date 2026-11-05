import { coverageEnabled, sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      // Coverage consolidated at root vitest.config.mts
      coverage: {
        enabled: coverageEnabled,
        exclude: [
          '**/*.d.ts',
          '**/*.config.*',
          '**/dist/**',
          'src/index.ts',
          'src/constants/index.ts',
          'src/types/store-types.ts',
        ],
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        provider: 'v8',
      },
      // The store persists through `localStorage`, which only a DOM environment provides.
      environment: 'happy-dom',
      include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
      setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
    },
  })
);
