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
        resolve: {
          alias: {
            electron: path.resolve(import.meta.dirname, '__mocks__/electron.ts'),
          },
        },
        test: {
          environment: 'jsdom',
          exclude: ['node_modules', 'dist', '**/*.browser.test.{ts,tsx}'],
          globals: true,
          include: ['src/__tests__/**/*.test.{ts,tsx}'],
          name: 'unit',
          // Vitest 4: server.deps replaces the deprecated deps config
          server: {
            deps: {
              external: ['electron'],
            },
          },
        },
      },
      {
        test: {
          browser: {
            enabled: true,
            instances: [{ browser: 'chromium' }],
            provider: playwright(),
            // Capture screenshots on failure for quick visual debugging
            screenshotFailures: true,
            // Playwright trace: capture only for failing tests in CI
            trace: process.env['CI'] ? 'retain-on-failure' : 'off',
          },
          globals: true,
          include: ['src/__tests__/**/*.browser.test.{ts,tsx}'],
          name: 'browser',
          // Output directory for traces and screenshots
          outputDir: 'test-results',
        },
      },
    ],
  },
});
