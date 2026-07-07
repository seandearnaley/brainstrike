import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}', '__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['src/vitest.setup.ts'],
  },
});
