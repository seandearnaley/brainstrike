import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { reactCompiler } from '@brainstrike/test-utils/vitest-react-compiler';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [reactCompiler()],
    test: {
      coverage: {
        exclude: ['**/node_modules/**', '**/dist/**', '**/*.d.ts'],
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
      },
      environment: 'happy-dom',
      include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/*.test.tsx', 'src/**/*.spec.tsx'],
      // Adaptive: prevent oversubscription on CI (2 vCPU), uncapped locally
      maxWorkers: process.env['CI'] ? '50%' : '100%',
    },
  })
);
