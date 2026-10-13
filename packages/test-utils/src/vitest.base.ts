import type { InlineConfig } from 'vitest/node';

// Shared Vitest base config for Brainstrike
// Packages can import and spread this into their local config:
//   import { defineConfig } from 'vitest/config';
//   import { testBase } from '@brainstrike/test-utils/vitest.base';
//   export default defineConfig({ test: { ...testBase, /* package overrides */ } });

export const testBase: InlineConfig = {
  clearMocks: true,
  // Default to happy-dom for React unit/integration tests; override per package if needed
  environment: 'happy-dom',
  globals: true,
  hookTimeout: 15_000,
  // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
  maxWorkers: process.env['CI'] ? '50%' : '100%',
  mockReset: true,
  // Forks, Vitest's default. Node 26 worker threads segfault in ModuleWrap's per-Environment
  // module map under load, on macOS and Linux (BST-2002); forks start no worker threads.
  pool: 'forks',
  restoreMocks: true,
  setupFiles: ['@brainstrike/test-utils/vitest.setup'],
  testTimeout: 10_000,
};
