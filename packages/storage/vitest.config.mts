/// <reference types="vitest" />

import path from 'node:path';
import {
  resolveVisualBaselinePath,
  withBoundedTraceChunkNames,
} from '@brainstrike/config/vitest-browser';
import { sharedConfig } from '@brainstrike/test-utils/vitest.base';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig } from 'vitest/config';

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
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      projects: [
        {
          resolve: {
            alias: [
              {
                find: 'electron',
                replacement: path.resolve(import.meta.dirname, '__mocks__/electron.ts'),
              },
            ],
          },
          test: {
            environment: 'jsdom',
            exclude: ['node_modules', 'dist', '**/*.browser.test.{ts,tsx}'],
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
              expect: {
                toMatchScreenshot: {
                  resolveScreenshotPath: resolveVisualBaselinePath,
                },
              },
              instances: [{ browser: 'chromium' }],
              // CI launch args match the db browser project / the shared
              // createPlaywrightOptions helper: job containers get Docker's
              // default 64 MB /dev/shm, so Chromium needs
              // --disable-dev-shm-usage (et al.) or it can crash mid-suite
              // (review #2158 — this project previously passed no args and had
              // simply never run in a container).
              // withBoundedTraceChunkNames: long test names otherwise overflow
              // the 255-byte attachment filename and the ENAMETOOLONG masks the
              // real failure (see @brainstrike/config's vitest-browser).
              provider: withBoundedTraceChunkNames(
                playwright({
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
                })
              ),
              // Capture screenshots on failure for quick visual debugging. No
              // traces: recording every test to keep the failures' traces cost
              // the shared Vitest process more than the tests (see
              // createBrowserProject in @brainstrike/config).
              screenshotFailures: true,
            },
            include: ['src/__tests__/**/*.browser.test.{ts,tsx}'],
            name: 'browser',
            // Output directory for traces and screenshots
            outputDir: 'test-results',
          },
        },
      ],
    },
  })
);
