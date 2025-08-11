import {
  getCILaunchArgs,
  getEnvironmentConfig,
  logEnvironmentConfig,
  validateEnvironmentConfig,
} from '@brainstrike/config/playwright-environment';
import type { PlaywrightTestConfig } from '@playwright/test';

// Get environment configuration
const config = getEnvironmentConfig();

// Log environment detection for debugging
logEnvironmentConfig('Desktop', config);

// Validate configuration and show warnings
validateEnvironmentConfig(config);

const playwrightConfig: PlaywrightTestConfig = {
  testDir: './e2e',

  // Global timeout based on environment
  globalTimeout: config.globalTimeout,

  // Per-test timeout - Electron apps can be slower to start
  timeout: 60_000,

  // Don't run tests in parallel - Electron can be resource intensive
  fullyParallel: false,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: config.isCI,

  // Retry strategy based on environment
  retries: config.retries,

  // Worker count based on environment capabilities
  // Force single worker for desktop to avoid test interference
  workers: 1,

  // Reporter configuration: always produce HTML and Blob for CI merging and local viewing
  reporter: config.isCI
    ? [
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
        ['blob', { outputDir: 'blob-report' }],
        ['list'],
      ]
    : [['html', { open: 'never', outputFolder: 'playwright-report' }], ['list']],

  // Expect timeout for assertions
  expect: {
    timeout: 10000,
  },

  use: {
    // Always use headless mode to prevent X server issues in CI
    // Local development can override with --headed flag if needed
    headless: true,

    // CI-optimized launch options for resource-constrained environments
    ...(config.isCI && {
      launchOptions: {
        args: getCILaunchArgs(),
      },
    }),

    // Collect trace when retrying failed tests
    trace: config.isCI ? 'on' : 'on-first-retry',

    // Take screenshot on failure
    screenshot: 'only-on-failure',

    // Record video on retry
    video: 'retain-on-failure',

    // Use data-testid for element selection
    testIdAttribute: 'data-testid',
  },

  // Test match patterns
  testMatch: ['**/*.test.ts'],

  // Test ignore patterns - exclude unit tests in __tests__ directories
  testIgnore: ['**/__tests__/**', '**/node_modules/**', '**/dist/**', '**/build/**'],

  // Global setup for Electron app
  globalSetup: './e2e/global-setup.ts',

  // Output directory for test artifacts (screenshots, traces, videos)
  outputDir: 'test-results/',
};

export default playwrightConfig;
