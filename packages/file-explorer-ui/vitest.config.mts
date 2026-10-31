import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { reactCompiler } from '@brainstrike/test-utils/vitest-react-compiler';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [reactCompiler()],
    test: {
      clearMocks: true,
      // jsdom-only suites annotate the file instead.
      environment: 'happy-dom',
      hookTimeout: 15_000,
      include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
      mockReset: true,
      restoreMocks: true,
      setupFiles: [
        '@brainstrike/test-utils/vitest.dom-aware.setup',
        './src/__tests__/setup/suppress-token-utils-warnings.ts',
      ],
      testTimeout: 30_000,
    },
  })
);
