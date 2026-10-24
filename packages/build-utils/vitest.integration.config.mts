import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

/** Real bundler and native-process evidence belongs in the uncached integration task. */
export default defineConfig({
  ...baseConfig,
  test: {
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    ...baseConfig.test,
    coverage: { enabled: false },
    include: ['src/__tests__/**/*.integration.test.{ts,tsx}'],
  },
});
