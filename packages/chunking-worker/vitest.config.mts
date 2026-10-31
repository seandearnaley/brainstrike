import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageEnabled, sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      coverage: {
        enabled: coverageEnabled,
        exclude: ['**/*.d.ts', '**/*.config.*', '**/dist/**'],
        include: ['src/**/*.ts'],
        provider: 'v8',
      },
      include: ['src/__tests__/**/*.test.{ts,tsx}'],
      // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
      maxWorkers: process.env['CI'] ? '50%' : '100%',
      setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
    },
  })
);
