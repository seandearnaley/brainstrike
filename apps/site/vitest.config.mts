import { defineConfig } from 'vitest/config';

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

export default defineConfig({
  test: {
    coverage: {
      enabled: coverageEnabled,
      exclude: ['**/*.test.*', '**/main.tsx'],
      include: ['src/**/*.{ts,tsx}'],
      provider: 'v8',
      reporter: ['text', 'lcov', 'json'],
      reportsDirectory: './coverage',
    },
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
