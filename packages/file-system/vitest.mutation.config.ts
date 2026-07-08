import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    reporters: 'basic',
    silent: true,
  },
});
