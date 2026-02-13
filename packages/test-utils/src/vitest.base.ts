import type { InlineConfig } from 'vitest/node';

// Shared Vitest base config for Brainstrike
// Packages can import and spread this into their local config:
//   import { defineConfig } from 'vitest/config';
//   import { testBase } from '@brainstrike/test-utils/vitest.base';
//   export default defineConfig({ test: { ...testBase, /* package overrides */ } });

export const testBase: InlineConfig = {
  globals: true,
  mockReset: true,
  restoreMocks: true,
  clearMocks: true,
  testTimeout: 10_000,
  hookTimeout: 15_000,
  pool: 'threads',
  // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
  maxWorkers: process.env['CI'] ? '50%' : '100%',
  // Default to happy-dom for React unit/integration tests; override per package if needed
  environment: 'happy-dom',
  setupFiles: ['@brainstrike/test-utils/vitest.setup'],
};
