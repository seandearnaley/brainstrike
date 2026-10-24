import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {},
  test: {
    coverage: {
      exclude: ['src/__tests__/**', 'dist/**', 'node_modules/**'],
      include: ['src/**/*.{ts,tsx}'],
    },
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
  },
});
