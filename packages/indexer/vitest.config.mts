import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { defineConfig } from 'vitest/config';

// Coverage also runs the real-process suites, which need the integration
// config's node runtime bundle and its aliases.
const realProcesses = process.argv.includes('--coverage')
  ? (await import('./vitest.integration.config.mts')).default
  : undefined;

export default defineConfig({
  ...(realProcesses ? { resolve: realProcesses.resolve } : {}),
  test: {
    ...(realProcesses ? { env: realProcesses.test?.env } : {}),
    coverage: { reportOnFailure: true },
    environment: 'node',
    // Coverage also runs the real-process integration suites, with the forked
    // indexers instrumented. On the 2-vCPU nightly runner, and under a local
    // throttle that reproduces it, their cases take up to 13.7 s (0.5-1.7 s
    // unthrottled), past Vitest's 5 s test and 10 s hook defaults. hookTimeout
    // and testTimeout both scale with TEST_TIMEOUT_MULTIPLIER.
    hookTimeout: getAdjustedTimeout('integration'),
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    testTimeout: getAdjustedTimeout('integration'),
  },
});
