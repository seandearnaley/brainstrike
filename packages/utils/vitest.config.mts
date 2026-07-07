import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@brainstrike/utils': resolve(import.meta.dirname, './src'),
      '@brainstrike/utils/log-buffer': resolve(import.meta.dirname, './src/log-buffer.ts'),
      '@brainstrike/utils/logger': resolve(import.meta.dirname, './src/logger.ts'),
      '@brainstrike/utils/logging-initializer': resolve(
        import.meta.dirname,
        './src/logging-initializer.ts'
      ),
      '@brainstrike/utils/logging-preferences': resolve(
        import.meta.dirname,
        './src/logging-preferences.ts'
      ),
    },
  },
  test: {
    coverage: {
      exclude: ['src/__tests__/**', 'dist/**', 'node_modules/**'],
      include: ['src/**/*.{ts,tsx}'],
    },
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    globals: true,
    hookTimeout: 15_000,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    // Longer timeout for tiktoken WASM initialization under parallel load
    testTimeout: 30_000,
  },
});
