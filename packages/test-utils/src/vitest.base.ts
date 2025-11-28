import os from 'node:os';
import type { TestUserConfig } from 'vitest/config';

// Determine max workers from env once to satisfy both TS and Biome
const envMaxStr = process.env['VITEST_MAX_THREADS'] ?? process.env['VITEST_MAX_WORKERS'];
const envMax = Number(envMaxStr);

// Calculate default max workers (cap to avoid oversubscription in CI)
const defaultMaxWorkers = Math.max(1, Math.min(4, (os.cpus?.().length ?? 2) - 1));

// Shared Vitest base config for Brainstrike (2025 baseline)
// Packages can import and spread this into their local config:
//   import { defineConfig } from 'vitest/config';
//   import { testBase } from '@brainstrike/test-utils/vitest.base';
//   export default defineConfig({ test: { ...testBase, /* package overrides */ } });

export const testBase: TestUserConfig = {
  globals: true,
  mockReset: true,
  restoreMocks: true,
  clearMocks: true,
  testTimeout: 10_000,
  hookTimeout: 15_000,
  pool: 'threads',
  // Vitest 4: use maxWorkers instead of poolOptions.threads.maxThreads
  maxWorkers: Number.isFinite(envMax) && envMax > 0 ? envMax : defaultMaxWorkers,
  // Default to happy-dom for React unit/integration tests; override per package if needed
  environment: 'happy-dom',
  setupFiles: ['@brainstrike/test-utils/vitest.setup'],
};
