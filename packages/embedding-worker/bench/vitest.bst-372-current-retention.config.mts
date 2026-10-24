import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {},
  test: {
    clearMocks: true,
    coverage: { enabled: false },
    environment: 'node',
    globals: true,
    include: ['bench/bst-372-current-retention.measurement.spec.ts'],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
