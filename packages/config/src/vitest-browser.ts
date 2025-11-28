/**
 * Shared Vitest 4 Browser Mode configuration utilities
 * Used for packages requiring real browser APIs (WASM, IndexedDB, localStorage)
 *
 * @see https://vitest.dev/guide/browser/
 */

import type { PlaywrightProviderOptions } from '@vitest/browser-playwright';
import { playwright } from '@vitest/browser-playwright';

export interface BrowserTestConfig {
  /** Test file pattern for browser tests (default: '**\/*.browser.test.{ts,tsx}') */
  testPattern?: string;
  /** Whether running in CI environment */
  isCI?: boolean;
  /** Playwright launch args for the browser */
  launchArgs?: string[];
  /** Headless mode (default: true) */
  headless?: boolean;
}

/**
 * Default CI launch arguments for browser stability
 */
const CI_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-setuid-sandbox',
  '--disable-features=VizDisplayCompositor',
];

/**
 * Creates Playwright provider options for Vitest 4 Browser Mode
 */
export function createPlaywrightOptions(config?: BrowserTestConfig): PlaywrightProviderOptions {
  const isCI = config?.isCI ?? Boolean(process.env['CI']) ?? Boolean(process.env['GITHUB_ACTIONS']);
  const launchArgs = config?.launchArgs ?? (isCI ? CI_LAUNCH_ARGS : []);

  // Only include launchOptions if there are args to pass
  if (launchArgs.length > 0) {
    return {
      launchOptions: {
        args: launchArgs,
      },
    };
  }

  return {};
}

/**
 * Creates a browser test project configuration for Vitest 4
 *
 * @example
 * ```ts
 * import { defineConfig } from 'vitest/config';
 * import { createBrowserProject } from '@brainstrike/config/vitest-browser';
 *
 * export default defineConfig({
 *   test: {
 *     projects: [
 *       { // Unit tests with jsdom
 *         test: {
 *           name: 'unit',
 *           environment: 'jsdom',
 *           include: ['**\/*.test.ts'],
 *         },
 *       },
 *       createBrowserProject(), // Browser tests
 *     ],
 *   },
 * });
 * ```
 */
export function createBrowserProject(config?: BrowserTestConfig) {
  const testPattern = config?.testPattern ?? '**/*.browser.test.{ts,tsx}';
  const headless = config?.headless ?? true;

  return {
    test: {
      name: 'browser',
      include: [testPattern],
      browser: {
        enabled: true,
        provider: playwright(createPlaywrightOptions(config)),
        instances: [{ browser: 'chromium' as const }],
        headless,
      },
    },
  };
}

/**
 * Re-export playwright provider for direct use
 */
export { playwright };
export type { PlaywrightProviderOptions };
