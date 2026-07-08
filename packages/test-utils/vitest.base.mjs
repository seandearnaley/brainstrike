// ESM export for use from Vitest/Vite config files without TS transpilation
import os from 'node:os';

const envMax = Number(process.env['VITEST_MAX_THREADS'] ?? process.env['VITEST_MAX_WORKERS']);
const defaultMaxWorkers = Math.max(1, Math.min(4, (os.cpus?.().length ?? 2) - 1));
export const testBase = {
  clearMocks: true,
  environment: 'happy-dom',
  globals: true,
  hookTimeout: 15_000,
  // Vitest 4: use maxWorkers instead of poolOptions.threads.maxThreads
  maxWorkers: Number.isFinite(envMax) && envMax > 0 ? envMax : defaultMaxWorkers,
  mockReset: true,
  pool: 'threads',
  restoreMocks: true,
  setupFiles: ['@brainstrike/test-utils/vitest.setup'],
  testTimeout: 10_000,
};
