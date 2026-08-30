/// <reference types="vitest" />

import path from 'node:path';
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import {
  resolveVisualBaselinePath,
  withBoundedTraceChunkNames,
} from '../config/src/vitest-browser.ts';

// Resolve workspace deps (platform-utils, utils) from SOURCE, not built dist.
// Applied per-project (vitest 4 does not inherit the root-level resolve into
// `test.projects`). See workspace-src-aliases (incident #1066/#1207).
const srcAliases = workspaceSrcAliases(path.resolve(import.meta.dirname, '..'));

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
          // Local electron mock wins over the registry (first-match ordering).
          alias: [
            {
              find: 'electron',
              replacement: path.resolve(import.meta.dirname, '__mocks__/electron.ts'),
            },
            ...srcAliases,
          ],
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
        resolve: { alias: srcAliases },
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
    reporters: ['default', new LostTestFileReporter()],
  },
});
