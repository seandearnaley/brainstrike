import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    coverage: { enabled: false },
    include: ['**/*.integration.test.?(c|m)[jt]s?(x)'],
  },
});
