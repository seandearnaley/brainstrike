/**
 * Shared Vitest 4 Browser Mode configuration utilities
 * Used for packages requiring real browser APIs (WASM, IndexedDB, localStorage)
 *
 * @see https://vitest.dev/guide/browser/
 */

import type { PlaywrightProviderOptions } from '@vitest/browser-playwright';
import { playwright } from '@vitest/browser-playwright';

export interface BrowserTestConfig {
  /** Headless mode (default: true) */
  headless?: boolean;
  /** Whether running in CI environment */
  isCI?: boolean;
  /** Playwright launch args for the browser */
  launchArgs?: string[];
  /** Test file pattern for browser tests (default: '**\/*.browser.test.{ts,tsx}') */
  testPattern?: string;
  /**
   * Playwright trace mode for debugging failed tests
   * - 'off': No traces (default for local dev)
   * - 'on': Always generate traces (performance impact)
   * - 'on-first-retry': Capture traces only when test is retried first time
   * - 'on-all-retries': Capture traces on every retry
   * - 'retain-on-failure': Keep traces only for failed tests (recommended for CI)
   * @see https://vitest.dev/config/browser/trace
   */
  trace?: 'off' | 'on' | 'on-first-retry' | 'on-all-retries' | 'retain-on-failure';
  /** Directory for trace output (default: 'test-results') */
  traceOutputDir?: string;
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

const resolveIsCI = (config?: BrowserTestConfig): boolean =>
  config?.isCI ?? Boolean(process.env['CI'] || process.env['GITHUB_ACTIONS']);

/**
 * Creates Playwright provider options for Vitest 4 Browser Mode
 */
export function createPlaywrightOptions(config?: BrowserTestConfig): PlaywrightProviderOptions {
  const isCI = resolveIsCI(config);
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
  const isCI = resolveIsCI(config);

  // Enable traces on failure in CI by default for debugging
  const trace = config?.trace ?? (isCI ? 'retain-on-failure' : 'off');
  const traceOutputDir = config?.traceOutputDir ?? 'test-results';

  return {
    test: {
      browser: {
        enabled: true,
        headless,
        instances: [{ browser: 'chromium' as const }],
        provider: playwright(createPlaywrightOptions(config)),
        // Capture screenshots on failure for quick visual debugging
        screenshotFailures: true,
        // Playwright trace configuration
        // Generates .zip trace files viewable with `npx playwright show-trace <file>`
        trace,
      },
      include: [testPattern],
      name: 'browser',
      // Output directory for traces and screenshots
      outputDir: traceOutputDir,
    },
  };
}

export type { PlaywrightProviderOptions };
/**
 * Re-export playwright provider for direct use
 */
export { playwright };
