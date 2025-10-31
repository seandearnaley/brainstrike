import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/*.spec.ts'],
    environment: 'node',
  },
  coverage: {
    enabled: coverageEnabled,
    provider: 'v8',
    reporter: ['text', 'json', 'lcov'],
    include: ['src/**/*.{ts,tsx}'],
  },
});
