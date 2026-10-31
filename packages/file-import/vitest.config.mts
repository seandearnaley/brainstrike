import { coverageEnabled, sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      // Coverage consolidated at root vitest.config.mts
      coverage: {
        enabled: coverageEnabled,
        exclude: ['**/*.d.ts', '**/*.config.*', '**/dist/**'],
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        provider: 'v8',
      },
      environment: 'happy-dom',
      include: ['src/__tests__/**/*.test.{ts,tsx}'],
      // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
      maxWorkers: process.env['CI'] ? '50%' : '100%',
      setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    },
  })
);
