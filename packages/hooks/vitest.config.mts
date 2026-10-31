import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { reactCompiler } from '@brainstrike/test-utils/vitest-react-compiler';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [reactCompiler()],
    test: {
      clearMocks: true,
      environment: 'happy-dom',
      hookTimeout: 15_000,
      include: ['src/__tests__/**/*.test.{ts,tsx}'],
      mockReset: true,
      restoreMocks: true,
      setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
      testTimeout: 10_000,
    },
  })
);
