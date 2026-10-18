import { resolve } from 'node:path';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: {
    alias: [
      // Coverage also runs real process cases; their entry needs emitted siblings.
      ...(process.argv.includes('--coverage')
        ? [
            {
              find: /^@brainstrike\/indexer$/,
              replacement: resolve(import.meta.dirname, './dist/index.js'),
            },
          ]
        : []),
      ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
    ],
  },
  test: {
    coverage: { reportOnFailure: true },
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    // Coverage also runs the real-process integration suites, with the forked
    // indexers instrumented. On the 2-vCPU nightly runner, and under a local
    // throttle that reproduces it, their cases take up to 13.7 s (0.5-1.7 s
    // unthrottled), past Vitest's 5 s default. Scaled by TEST_TIMEOUT_MULTIPLIER.
    testTimeout: getAdjustedTimeout('integration'),
  },
});
