import { coverageEnabled, sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { reactCompiler } from '@brainstrike/test-utils/vitest-react-compiler';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
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
        ],
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
      },
      environment: 'jsdom',
      maxWorkers: process.env['CI'] ? '50%' : '100%',
      // Hook-free: applies TEST_TIMEOUT_MULTIPLIER to @testing-library/dom's
      // waitFor/findBy budget and nothing else (BST-1299). This lane opts out
      // of the shared vitest.setup (which registers beforeEach/afterEach
      // hooks), but its suites still use waitFor and would otherwise sit on
      // the library's unscalable 1s default. Applied only where the file's
      // environment has a DOM; node-environment files skip the import.
      setupFiles: [
        '@brainstrike/test-utils/vitest.dom-aware-timeouts.setup',
        '@brainstrike/test-utils/zustand-store-reset',
      ],
      testTimeout: 15_000,
    },
  })
);
