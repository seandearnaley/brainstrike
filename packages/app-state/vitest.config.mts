import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

export default defineConfig({
  resolve: {
    alias: workspaceSrcAliases(resolve(import.meta.dirname, '..')),
  },
  test: {
    coverage: {
      enabled: coverageEnabled,
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.*',
        'src/**/__tests__/**',
        '**/index.ts',
      ],
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        branches: 60,
        functions: 60,
        lines: 70,
        statements: 70,
      },
    },
    environment: 'jsdom',
    globals: true,
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    reporters: ['default', new LostTestFileReporter()],
    // Hook-free: applies TEST_TIMEOUT_MULTIPLIER to @testing-library/dom's
    // waitFor/findBy budget and nothing else (BST-1299). This lane opts out
    // of the shared vitest.setup (which registers beforeEach/afterEach
    // hooks), but its suites still use waitFor and would otherwise sit on
    // the library's unscalable 1s default. Applied only where the file's
    // environment has a DOM; node-environment files skip the import.
    setupFiles: ['@brainstrike/test-utils/vitest.dom-aware-timeouts.setup'],
    testTimeout: 15_000,
  },
});
