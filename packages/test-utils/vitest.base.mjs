// ESM export for use from Vitest/Vite config files without TS transpilation
import os from 'node:os';
const envMax = Number(process.env['VITEST_MAX_THREADS'] ?? process.env['VITEST_MAX_WORKERS']);
const defaultMaxWorkers = Math.max(1, Math.min(4, (os.cpus?.().length ?? 2) - 1));
export const testBase = {
  globals: true,
  mockReset: true,
  restoreMocks: true,
  clearMocks: true,
  testTimeout: 10_000,
  hookTimeout: 15_000,
  pool: 'threads',
  // Vitest 4: use maxWorkers instead of poolOptions.threads.maxThreads
  maxWorkers: Number.isFinite(envMax) && envMax > 0 ? envMax : defaultMaxWorkers,
  environment: 'happy-dom',
  setupFiles: ['@brainstrike/test-utils/vitest.setup'],
};
