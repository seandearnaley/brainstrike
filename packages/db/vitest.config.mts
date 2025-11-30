import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

/**
 * November 2025 Vitest 4 configuration for @brainstrike/db
 *
 * Test projects:
 * - unit: jsdom-based tests with PGlite mocks (fast, CI-friendly)
 * - browser: Real browser tests for WASM/IndexedDB validation
 *
 * Browser tests use *.browser.test.ts naming convention.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./vitest.setup.ts'],
          include: ['__tests__/**/*.test.{ts,tsx}'],
          exclude: ['node_modules', 'dist', '**/*.browser.test.{ts,tsx}'],
          env: {
            TEST_PGLITE_MOCK: 'true',
          },
          pool: 'threads',
          // Vitest 4: use maxWorkers: 1 instead of poolOptions.threads.singleThread
          maxWorkers: 1,
          hookTimeout: 10_000,
          testTimeout: 10_000,
        },
      },
      {
        test: {
          name: 'browser',
          include: ['__tests__/**/*.browser.test.{ts,tsx}'],
          // Output directory for traces and screenshots
          outputDir: 'test-results',
          browser: {
            enabled: true,
            provider: playwright({
              launchOptions: {
                args: process.env['CI']
                  ? [
                      '--no-sandbox',
                      '--disable-dev-shm-usage',
                      '--disable-setuid-sandbox',
                      '--disable-features=VizDisplayCompositor',
                    ]
                  : [],
              },
            }),
            instances: [{ browser: 'chromium' }],
            headless: true,
            // Playwright trace: capture only for failing tests in CI
            trace: process.env['CI'] ? 'retain-on-failure' : 'off',
            // Capture screenshots on failure for quick visual debugging
            screenshotFailures: true,
          },
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
