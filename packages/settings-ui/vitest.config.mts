import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { reactCompiler } from '@brainstrike/test-utils/vitest-react-compiler';
import { defineConfig } from 'vitest/config';

const coverageEnabled =
  process.env['COVERAGE'] !== 'false' &&
  (process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true');

export default defineConfig({
  plugins: [reactCompiler()],
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
        'src/settings/models/model-selection-page.tsx',
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
    environment: 'happy-dom',
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globals: true,
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    reporters: ['default', new LostTestFileReporter()],
    // The timeout-only setup scales waitFor/findBy without shared cleanup
    // hooks (BST-1299), in files whose environment has a DOM.
    setupFiles: [
      '@brainstrike/test-utils/vitest.dom-aware-timeouts.setup',
      '@brainstrike/test-utils/zustand-store-reset',
    ],
    testTimeout: 15_000,
  },
});
