import { defineConfig } from 'vitest/config';
import LostTestFileReporter from './vitest-lost-file-reporter.mjs';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    exclude: ['node_modules', 'dist'],
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    include: ['src/__tests__/**/*.test.{ts,tsx}', '__tests__/**/*.test.{ts,tsx}'],
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: ['src/vitest.setup.ts'],
  },
});
