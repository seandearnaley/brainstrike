// Real socket, process identity, start-order race and lifetime integration lane.
// `test:integration` runs it through the root uncached `test:integration` task.
// It reuses the base config and REPLACES only `test.include` with the
// integration suffix, mirroring the pure lane's `--exclude`, so the two lanes
// partition the suite (scripts/__tests__/integration-suffix-partition.test.mjs).
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.mts';

const baseTest = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    coverage: { ...(baseTest.coverage ?? {}), enabled: false },
    include: ['**/*.integration.test.?(c|m)[jt]s?(x)'],
  },
});
