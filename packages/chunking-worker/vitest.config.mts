import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['../../packages/test-utils/src/vitest.setup.ts'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    pool: 'threads',
    maxWorkers: 4,
    coverage: {
      enabled: coverageEnabled,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/*.config.*', '**/dist/**', 'src/chunking.worker.ts'],
    },
  },
});
