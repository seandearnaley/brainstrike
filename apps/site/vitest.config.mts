import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

export default defineConfig({
  test: {
    coverage: {
      enabled: coverageEnabled,
      exclude: ['**/*.test.*', '**/main.tsx'],
      include: ['src/**/*.{ts,tsx}'],
      provider: 'v8',
      reporter: ['text', 'lcov', 'json'],
      reportsDirectory: './coverage',
    },
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // BST-1221: a V8-JIT-killed worker can silently drop a whole test file;
    // this reporter turns that into a hard failure. Registration is enforced
    // by scripts/__tests__/verify-lost-file-reporter.test.mjs.
    reporters: ['default', new LostTestFileReporter()],
  },
});
