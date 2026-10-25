import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'html', 'clover', 'json'],
    },
    environment: 'node',
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    reporters: ['default', new LostTestFileReporter()],
  },
});
