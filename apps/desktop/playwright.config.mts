import {
  getCILaunchArgs,
  getEnvironmentConfig,
  harmonizeColorEnvironment,
  logEnvironmentConfig,
  validateEnvironmentConfig,
} from '@brainstrike/config/playwright-environment';
import type { PlaywrightTestConfig } from '@playwright/test';

harmonizeColorEnvironment();

// Get environment configuration
const config = getEnvironmentConfig();

// Log environment detection for debugging
logEnvironmentConfig('Desktop', config);

// Validate configuration and show warnings
validateEnvironmentConfig(config);

const playwrightConfig: PlaywrightTestConfig = {
  // Expect timeout for assertions
  expect: {
    timeout: 10_000,
  },

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: config.isCI,

  // Tests, not files, are the unit of scheduling and sharding: each test owns its
  // app and profile. A spec whose tests depend on each other declares
  // test.describe.configure({ mode: 'serial' }).
  fullyParallel: config.fullyParallel,

  // Global setup for Electron app
  globalSetup: './e2e/global-setup.ts',

  // Global timeout based on environment
  globalTimeout: config.globalTimeout,

  // Per-test artifacts (traces, screenshots, videos, error context). Keep this
  // apart from the blob reporter's folder: that reporter deletes its folder
  // before it zips these attachments into the report (BST-2208).
  outputDir: 'test-results/',

  // Projects for selective test execution
  projects: [
    {
      grep: /@smoke/,
      name: 'smoke',
    },
    {
      grepInvert: /@smoke/,
      name: 'regression',
    },
  ],

  // Reporter configuration
  reporter: config.isCI
    ? [['blob', { outputDir: 'blob-report' }], ['list']]
    : [['html', { open: 'never' }], ['list']],

  // Retry strategy based on environment
  retries: config.retries,
  testDir: './e2e',

  // Test ignore patterns - exclude unit tests in __tests__ directories
  testIgnore: ['**/__tests__/**', '**/node_modules/**', '**/dist/**', '**/build/**'],

  // Test match patterns
  testMatch: ['**/*.test.ts'],

  // Per-test timeout - Electron apps can be slower to start
  // Increased to 2 minutes to handle parallel shard load in CI/Act
  timeout: 120_000,
  tsconfig: './tsconfig.e2e.json',

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

    // BST-2239: the harness takes the failure screenshot itself, of the main window, before it
    // closes the app (e2e/utils/failure-screenshot.ts). With 'only-on-failure' Playwright
    // screenshots every page of the closing app before it asks Main to quit, inside the 10 s
    // close deadline: a hidden window took 2.2-5 s to capture on hosted windows-2025.
    // https://playwright.dev/docs/api/class-testoptions#test-options-screenshot
    screenshot: 'off',

    // Use data-testid for element selection
    testIdAttribute: 'data-testid',

    // Collect trace only on failure in CI to reduce overhead
    trace: config.isCI ? 'retain-on-failure' : 'on-first-retry',

    // Record video on retry
    video: 'retain-on-failure',
  },

  // Worker count based on environment capabilities. The Electron fixture derives
  // userDataDir from shard + worker index, so CI workers are isolated.
  workers: config.workers,
};

export default playwrightConfig;
