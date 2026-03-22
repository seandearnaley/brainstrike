import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/__tests__/**', 'dist/**', 'node_modules/**'],
    },
    // Longer timeout for tiktoken WASM initialization under parallel load
    testTimeout: 30_000,
    hookTimeout: 15_000,
  },
  resolve: {
    alias: {
      '@brainstrike/utils': resolve(import.meta.dirname, './src'),
      '@brainstrike/utils/logger': resolve(import.meta.dirname, './src/logger.ts'),
      '@brainstrike/utils/log-buffer': resolve(import.meta.dirname, './src/log-buffer.ts'),
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
});
