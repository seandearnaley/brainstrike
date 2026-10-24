import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

const baseTest = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    // One module cache per package, so parallel lanes never clear a shared one.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    ...baseTest,
    coverage: { ...(baseTest.coverage ?? {}), enabled: false },
    include: ['**/*.integration.test.?(c|m)[jt]s?(x)'],
  },
});
