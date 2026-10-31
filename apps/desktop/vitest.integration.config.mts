// The integration lane: `*.integration.test.*` files (native binaries, real
// child processes, loopback servers, real-clock assertions). The `test` script
// excludes the same suffix, so the two lanes partition the suite.
import { defineConfig } from 'vitest/config';
import baseConfig, { ELECTRON_RUNTIME_TESTS, UNDER_ELECTRON } from './vitest.config.mts';

const baseTest = baseConfig.test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    // `test` and `test:integration` can run at once in this package; two
    // coverage runs would share and clear one coverage/.tmp directory.
    coverage: { ...(baseTest.coverage ?? {}), enabled: false },
    // Under Electron (scripts/run-integration.mjs) only the files that need it run.
    include: UNDER_ELECTRON ? ELECTRON_RUNTIME_TESTS : ['**/*.integration.test.?(c|m)[jt]s?(x)'],
    // The unit-only cold boot project does not belong in the native lane.
    pool: 'forks',
    projects: undefined,
  },
});
