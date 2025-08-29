import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['../../packages/test-utils/src/vitest.setup.ts'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    // Coverage consolidated at root vitest.config.ts
  },
});
