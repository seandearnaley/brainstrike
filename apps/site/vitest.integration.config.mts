import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

const baseTest = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    coverage: { ...(baseTest.coverage ?? {}), enabled: false },
    include: ['src/**/*.integration.test.?(c|m)[jt]s?(x)'],
    passWithNoTests: true,
  },
});
