import { defineConfig } from 'vitest/config';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['test/**/*.spec.ts'],
    exclude: ['dist', 'node_modules'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      enabled: coverageEnabled,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.*', '**/__tests__/**', '**/dist/**', '**/node_modules/**'],
    },
  },
});
