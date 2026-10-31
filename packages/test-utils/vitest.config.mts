import { defineConfig, mergeConfig } from 'vitest/config';
import { sharedConfig } from './src/vitest.base.ts';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      environment: 'happy-dom',
      include: ['src/__tests__/**/*.test.{ts,tsx}', '__tests__/**/*.test.{ts,tsx}'],
      setupFiles: ['src/vitest.setup.ts'],
    },
  })
);
