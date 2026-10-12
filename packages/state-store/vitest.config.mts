import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [...workspaceSrcAliases(resolve(import.meta.dirname, '..'))],
  },
  test: {
    coverage: { reportOnFailure: true },
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    // One file at a time, as in the M0 spikes: the suites spawn competing
    // processes (lock races, SIGKILLed writers) and assert wall-clock bounds
    // (a display flush under 100 ms while a 400 ms sync is in flight), which
    // parallel files would turn into contention flakes.
    fileParallelism: false,
    globals: true,
    hookTimeout: 120_000,
    include: ['__tests__/**/*.test.ts'],
    reporters: ['default', new LostTestFileReporter()],
    testTimeout: 60_000,
  },
});
