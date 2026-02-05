/// <reference types="vitest" />

import path from 'node:path';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

/**
 * Vitest 4 configuration for @brainstrike/storage
 *
 * Defines two projects:
 * - "unit": jsdom environment with mocked electron for unit tests
 * - "browser": Real browser environment for localStorage/IndexedDB tests
 *
 * Run unit tests: vitest run (default)
 * Run browser tests: vitest run --project browser
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          globals: true,
          environment: 'jsdom',
          include: ['src/__tests__/**/*.test.{ts,tsx}'],
          exclude: ['node_modules', 'dist', '**/*.browser.test.{ts,tsx}'],
          // Vitest 4: server.deps replaces the deprecated deps config
          server: {
            deps: {
              external: ['electron'],
            },
          },
        },
        resolve: {
          alias: {
            electron: path.resolve(import.meta.dirname, '__mocks__/electron.ts'),
          },
        },
      },
      {
        test: {
          name: 'browser',
          globals: true,
          include: ['src/__tests__/**/*.browser.test.{ts,tsx}'],
          // Output directory for traces and screenshots
          outputDir: 'test-results',
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
            // Playwright trace: capture only for failing tests in CI
            trace: process.env['CI'] ? 'retain-on-failure' : 'off',
            // Capture screenshots on failure for quick visual debugging
            screenshotFailures: true,
          },
        },
      },
    ],
  },
});
