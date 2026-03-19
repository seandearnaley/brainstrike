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
          coverage: {
            enabled: process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true',
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['**/*.test.*', '**/__tests__/**', '**/dist/**', '**/node_modules/**'],
          },
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
            headless: process.env['CI'] === 'true',
            screenshotFailures: true,
          },
        },
      },
    ],
  },
});
