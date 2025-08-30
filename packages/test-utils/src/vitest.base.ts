import os from 'node:os';
import type { UserConfig } from 'vitest/config';

// Determine max threads from env once to satisfy both TS and Biome
// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access
const envMaxStr = process.env['VITEST_MAX_THREADS'] ?? process.env['VITEST_MAX_WORKERS'];
const envMax = Number(envMaxStr);

// Shared Vitest base config for Brainstrike (2025 baseline)
// Packages can import and spread this into their local config:
//   import { defineConfig } from 'vitest/config';
//   import { testBase } from '@brainstrike/test-utils/vitest.base';
//   export default defineConfig({ test: { ...testBase, /* package overrides */ } });

export const testBase: NonNullable<UserConfig['test']> = {
  globals: true,
  mockReset: true,
  restoreMocks: true,
  clearMocks: true,
  testTimeout: 10_000,
  hookTimeout: 15_000,
  pool: 'threads',
  poolOptions: {
    threads: {
      // Cap threads to avoid oversubscription in CI; allow env override
      maxThreads:
        Number.isFinite(envMax) && envMax > 0
          ? envMax
          : Math.max(1, Math.min(4, (os.cpus?.().length ?? 2) - 1)),
    },
  },
  // Default to happy-dom for React unit/integration tests; override per package if needed
  environment: 'happy-dom',
  setupFiles: ['@brainstrike/test-utils/vitest.setup'],
};
