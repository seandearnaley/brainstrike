import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['../../vitest.setup.ts'], // Point to root setup
    include: ['src/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
  resolve: {
    alias: {
      // No specific aliases needed for this package itself yet
    },
  },
}); 