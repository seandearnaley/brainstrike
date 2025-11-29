import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/*.spec.ts'],
    environment: 'node',
    // Longer timeout for MCP/Mastra integration tests under parallel load
    testTimeout: 30_000,
    hookTimeout: 15_000,
  },
  coverage: {
    enabled: coverageEnabled,
    provider: 'v8',
    reporter: ['text', 'json', 'lcov'],
    include: ['src/**/*.{ts,tsx}'],
  },
});
