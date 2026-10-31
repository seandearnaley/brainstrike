import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { reactCompiler } from '@brainstrike/test-utils/vitest-react-compiler';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [reactCompiler()],
    test: {
      environment: 'happy-dom',
      include: ['src/__tests__/**/*.test.{ts,tsx}'],
      isolate: true,
      setupFiles: ['@brainstrike/test-utils/vitest.setup'],
      testTimeout: 30_000,
    },
  })
);
