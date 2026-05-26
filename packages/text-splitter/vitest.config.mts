import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@brainstrike/utils/token-counting-heuristics': resolve(
        import.meta.dirname,
        '../utils/src/token-counting-heuristics.ts'
      ),
      '@brainstrike/utils/token-constants': resolve(
        import.meta.dirname,
        '../utils/src/token-constants.ts'
      ),
      '@brainstrike/utils/token-utils-accurate-lite': resolve(
        import.meta.dirname,
        '../utils/src/token-utils-accurate-lite.ts'
      ),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['../../packages/test-utils/src/vitest.setup.ts'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
});
