import {
  getCILaunchArgs,
  getEnvironmentConfig,
  logEnvironmentConfig,
  validateEnvironmentConfig,
} from '@brainstrike/config/playwright-environment';
import { DEFAULT_PORT, getBaseUrl } from '@brainstrike/server-config';
import { defineConfig } from '@playwright/test';

// Environment variable names
const baseUrlEnv = 'BASE_URL';
const fullBrowserCoverageEnv = 'PLAYWRIGHT_FULL_BROWSER_COVERAGE';

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
  testDir: './e2e',

  // Global timeout based on environment
  globalTimeout: config.globalTimeout,

  // Per-test timeout
  timeout: 60_000,

  // Parallel execution based on environment
  fullyParallel: config.fullyParallel,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: config.isCI,

  // Retry strategy based on environment
  retries: config.retries,

  // Worker count based on environment capabilities
  workers: config.workers,

  // Reporter configuration
  reporter: config.isCI
    ? [['blob', { outputDir: 'blob-report' }], ['list']]
    : [['html', { open: 'never' }], ['list']],

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

    // Tracing and media capture
    trace: config.isCI ? 'on' : 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    testIdAttribute: 'data-testid',
  },

  // Projects configuration with test type separation
  projects: useFullBrowserCoverage
    ? [
        // Functional tests - all browsers
        {
          name: 'functional-chromium',
          testMatch: '**/!(performance)/*.test.ts',
          use: { channel: 'chromium' },
          timeout: 60_000,
        },
        {
          name: 'functional-firefox',
          testMatch: '**/!(performance)/*.test.ts',
          use: { channel: 'firefox' },
          timeout: 60_000,
        },
        {
          name: 'functional-webkit',
          testMatch: '**/!(performance)/*.test.ts',
          use: { channel: 'webkit' },
          timeout: 60_000,
        },
        // Performance tests - Chromium only (most stable for performance measurements)
        {
          name: 'performance',
          testMatch: '**/performance/*.test.ts',
          use: { channel: 'chromium' },
          timeout: 120_000, // 2 minutes for performance tests
          retries: 1, // Fewer retries for performance tests
        },
      ]
    : [
        // Default: Chromium only with test type separation
        {
          name: 'functional',
          testMatch: '**/!(performance)/*.test.ts',
          use: { channel: 'chromium' },
          timeout: 60_000,
          grepInvert: /@nav-preserve/,
        },
        {
          name: 'performance',
          testMatch: '**/performance/*.test.ts',
          use: { channel: 'chromium' },
          timeout: 120_000, // 2 minutes for performance tests
          retries: 1, // Fewer retries for performance tests
        },
      ],

  // Test match patterns - exclude unit tests in __tests__ directories
  testMatch: '**/*.test.ts',
  testIgnore: ['**/__tests__/**', '**/node_modules/**'],

  globalSetup: './e2e/global-setup.ts',

  // Web server configuration - optimized for CI
  webServer: {
    command: config.isCI ? 'pnpm run start' : 'pnpm run dev',
    url: serverURL,
    reuseExistingServer: !config.isCI,
    timeout: 60000, // 1 minute timeout for server startup
    stderr: 'pipe',
    stdout: 'pipe',
  },
});
