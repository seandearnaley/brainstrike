import { resolve } from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { defineConfig } from 'vitest/config';

const workspaceAliases = workspaceSrcAliases(resolve(import.meta.dirname, '..'));

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    coverage: {
      exclude: ['**/__tests__/**', '**/*.d.ts', '**/dist/**', '**/index.ts'],
      include: ['src/**/*.{ts,tsx}'],
    },
    // jsdom + unstubGlobals match app-shell, where these suites lived — the
    // move stays behavior-preserving down to the DOM implementation.
    environment: 'jsdom',
    exclude: ['node_modules', 'dist'],
    globals: true,
    // The PGlite integration suites ran with these ceilings in app-shell;
    // vitest's 5s default times them out on CI's 2-vCPU runners (proven in
    // #2308's Coverage lane, which runs test:coverage over ALL suites).
    hookTimeout: 30_000,
    include: ['src/__tests__/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.test.{ts,tsx}'],
    maxWorkers: process.env['CI'] ? '50%' : '100%',
    reporters: ['default', new LostTestFileReporter()],
    setupFiles: [
      '@brainstrike/test-utils/vitest.event-loop-watchdog.setup',
      '@brainstrike/test-utils/vitest.setup',
    ],
    testTimeout: 30_000,
    unstubGlobals: true,
  },
});
