import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

/** Real bundler and native-process evidence belongs in the uncached integration task. */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    coverage: { enabled: false },
    include: ['src/__tests__/**/*.integration.test.{ts,tsx}'],
  },
});
