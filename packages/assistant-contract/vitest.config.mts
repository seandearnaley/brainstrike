import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
  },
});
