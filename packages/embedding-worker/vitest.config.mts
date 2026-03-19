import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          globals: true,
          setupFiles: ['@brainstrike/test-utils/vitest.setup'],
          include: ['test/**/*.spec.ts'],
          exclude: ['dist', 'node_modules', '**/*.browser.test.*'],
          restoreMocks: true,
          clearMocks: true,
        },
      },
      {
        test: {
          name: 'browser',
          globals: true,
          include: ['test/**/*.browser.test.{ts,tsx}'],
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
            headless: false, // Need real GPU for WebGPU tests
            screenshotFailures: true,
          },
        },
      },
    ],
  },
});
