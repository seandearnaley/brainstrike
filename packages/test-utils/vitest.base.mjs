// ESM export for use from Vitest/Vite config files without TS transpilation
import os from 'node:os';
const envMax = Number(process.env['VITEST_MAX_THREADS'] ?? process.env['VITEST_MAX_WORKERS']);
export const testBase = {
  globals: true,
  mockReset: true,
  restoreMocks: true,
  clearMocks: true,
  testTimeout: 10_000,
  hookTimeout: 15_000,
  pool: 'threads',
  poolOptions: {
    threads: {
      maxThreads: Number.isFinite(envMax) && envMax > 0
        ? envMax
        : Math.max(1, Math.min(4, (os.cpus?.().length ?? 2) - 1)),
    },
  },
  environment: 'happy-dom',
  setupFiles: ['@brainstrike/test-utils/vitest.setup'],
};
