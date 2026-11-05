import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { reactCompiler } from '@brainstrike/test-utils/vitest-react-compiler';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [reactCompiler()],
    test: {
      coverage: {
        exclude: ['**/__tests__/**', '**/*.d.ts', '**/dist/**', '**/index.ts'],
        include: ['src/**/*.{ts,tsx}'],
      },
      // jsdom + unstubGlobals match app-shell, where these suites lived — the
      // move stays behavior-preserving down to the DOM implementation.
      environment: 'jsdom',
      // These suites ran with these ceilings in app-shell;
      // vitest's 5s default times them out on CI's 2-vCPU runners (proven in
      // #2308's Coverage lane, which runs test:coverage over ALL suites).
      hookTimeout: 30_000,
      include: ['src/__tests__/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.test.{ts,tsx}'],
      maxWorkers: process.env['CI'] ? '50%' : '100%',
      setupFiles: ['@brainstrike/test-utils/vitest.dom-aware.setup'],
      testTimeout: 30_000,
      unstubGlobals: true,
    },
  })
);
