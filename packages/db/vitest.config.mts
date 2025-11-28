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
          hookTimeout: 10000,
          testTimeout: 10000,
        },
      },
      {
        test: {
          name: 'browser',
          include: ['__tests__/**/*.browser.test.{ts,tsx}'],
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
          },
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
});
