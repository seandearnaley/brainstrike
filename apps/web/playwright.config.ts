import {
  getCILaunchArgs,
  getEnvironmentConfig,
  harmonizeColorEnvironment,
  logEnvironmentConfig,
  validateEnvironmentConfig,
} from '@brainstrike/config/playwright-environment';
import { DEFAULT_PORT, getBaseUrl } from '@brainstrike/server-config';
import { defineConfig } from '@playwright/test';

// Environment variable names
const baseUrlEnv = 'BASE_URL';
const fullBrowserCoverageEnv = 'PLAYWRIGHT_FULL_BROWSER_COVERAGE';

// Mark local-first DB expected for web E2E unless explicitly disabled
process.env['LOCAL_FIRST_DB'] = process.env['LOCAL_FIRST_DB'] ?? 'true';
harmonizeColorEnvironment();

// Get environment configuration
const config = getEnvironmentConfig();

// Check if full browser coverage is requested
const useFullBrowserCoverage = !!process.env[fullBrowserCoverageEnv];

// Default to the server config port (8080) since that's where our dev server runs
const baseURL = process.env[baseUrlEnv] || getBaseUrl(DEFAULT_PORT);
const serverURL = getBaseUrl(DEFAULT_PORT);

// Log environment detection for debugging
logEnvironmentConfig('Web', config, baseURL);

// Validate configuration and show warnings
validateEnvironmentConfig(config);

export default defineConfig({
  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: config.isCI,

  // Parallel execution based on environment
  fullyParallel: config.fullyParallel,

  // NOTE: deliberately no globalSetup. The old one auto-redirected BASE_URL to
  // any vite-looking server found on nearby ports, silently running the suite
  // against a live dev server instead of the built preview below — the exact
  // nondeterminism the webServer contract exists to prevent. Target another
  // server explicitly with BASE_URL when needed.

  // Global timeout based on environment
  globalTimeout: config.globalTimeout,

  // Projects configuration with test type separation
  projects: useFullBrowserCoverage
    ? [
        // Functional tests - all browsers
        {
          name: 'functional-chromium',
          testMatch: '**/!(performance)/*.test.ts',
          timeout: 60_000,
          use: { channel: 'chromium' },
        },
        {
          name: 'functional-firefox',
          testMatch: '**/!(performance)/*.test.ts',
          timeout: 60_000,
          use: { channel: 'firefox' },
        },
        {
          name: 'functional-webkit',
          testMatch: '**/!(performance)/*.test.ts',
          timeout: 60_000,
          use: { channel: 'webkit' },
        },
        // Smoke tests - tagged critical subset across all browsers
        {
          grep: /@smoke/,
          name: 'smoke-chromium',
          testMatch: '**/!(performance)/*.test.ts',
          timeout: 60_000,
          use: { channel: 'chromium' },
        },
        {
          grep: /@smoke/,
          name: 'smoke-firefox',
          testMatch: '**/!(performance)/*.test.ts',
          timeout: 60_000,
          use: { channel: 'firefox' },
        },
        {
          grep: /@smoke/,
          name: 'smoke-webkit',
          testMatch: '**/!(performance)/*.test.ts',
          timeout: 60_000,
          use: { channel: 'webkit' },
        },
        // Performance tests - Chromium only (most stable for performance measurements)
        {
          name: 'performance',
          retries: 1, // Fewer retries for performance tests
          testMatch: '**/performance/*.test.ts',
          timeout: 120_000, // 2 minutes for performance tests
          use: { channel: 'chromium' },
        },
      ]
    : [
        // Default: Chromium only with test type separation
        {
          name: 'functional',
          testMatch: '**/!(performance)/*.test.ts',
          timeout: 60_000,
          use: { channel: 'chromium' },
        },
        {
          grep: /@smoke/,
          name: 'smoke',
          testMatch: '**/!(performance)/*.test.ts',
          timeout: 60_000,
          use: { channel: 'chromium' },
        },
        {
          name: 'performance',
          retries: 1, // Fewer retries for performance tests
          testMatch: '**/performance/*.test.ts',
          timeout: 120_000, // 2 minutes for performance tests
          use: { channel: 'chromium' },
        },
      ],

  // Reporter configuration
  reporter: config.isCI
    ? [['blob', { outputDir: 'blob-report' }], ['list']]
    : [['html', { open: 'never' }], ['list']],

  // Retry strategy based on environment
  retries: config.retries,
  testDir: './e2e',
  testIgnore: ['**/__tests__/**', '**/node_modules/**'],

  // Test match patterns - exclude unit tests in __tests__ directories
  testMatch: '**/*.test.ts',

  // Per-test timeout
  timeout: 60_000,

  use: {
    baseURL,

    // Always use headless mode in CI to prevent X server issues
    // Local development can override with --headed flag if needed
    headless: true,

    // CI-optimized launch options for resource-constrained environments
    ...(config.isCI && {
      launchOptions: {
        args: getCILaunchArgs(),
      },
    }),
    screenshot: 'only-on-failure',
    testIdAttribute: 'data-testid',

    // Tracing and media capture
    trace: config.isCI ? 'retain-on-failure' : 'on-first-retry',
    video: 'retain-on-failure',
  },

  // Web server configuration - optimized for CI
  webServer: {
    // Use the built preview server for deterministic E2E runs.
    // The repo contract runs `pnpm build` before `pnpm test:e2e`, so we should
    // execute against the built app instead of a live dev server that can still
    // optimize dependencies and trigger mid-test reloads.
    command: 'pnpm run start',
    reuseExistingServer: false,
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: 60_000, // 1 minute timeout for server startup
    url: serverURL,
  },

  // Worker count based on environment capabilities
  workers: config.workers,
});
