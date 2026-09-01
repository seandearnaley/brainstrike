import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    exclude: ['node_modules', 'dist'],
    include: ['__tests__/**/*.integration.test.ts'],
    testTimeout: 20_000,
  },
});
