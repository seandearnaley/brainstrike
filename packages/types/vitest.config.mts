import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    globals: true,
    // setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['__tests__/**/*.test.{ts,tsx}'],
  },
});
