import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

export default defineConfig({
  coverage: {
    enabled: coverageEnabled,
    include: ['src/**/*.{ts,tsx}'],
    provider: 'v8',
    reporter: ['text', 'json', 'lcov'],
  },
  test: {
    environment: 'node',
    hookTimeout: 15_000,
    include: ['src/**/__tests__/*.spec.ts'],
    // Longer timeout for MCP/Mastra integration tests under parallel load
    testTimeout: 30_000,
  },
});
