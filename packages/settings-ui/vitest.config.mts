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
          'src/settings/models/model-selection-page.tsx',
        ],
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
      },
      environment: 'happy-dom',
      maxWorkers: process.env['CI'] ? '50%' : '100%',
      // The timeout-only setup scales waitFor/findBy without shared cleanup
      // hooks (BST-1299), in files whose environment has a DOM.
      setupFiles: [
        '@brainstrike/test-utils/vitest.dom-aware-timeouts.setup',
        '@brainstrike/test-utils/zustand-store-reset',
      ],
      testTimeout: 15_000,
    },
  })
);
