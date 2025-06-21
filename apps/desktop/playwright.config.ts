import type { PlaywrightTestConfig } from '@playwright/test';

// Environment variable names
const ciEnv = 'CI';

// Check if running in CI environment
const isCI = !!process.env[ciEnv];

// Log important info for debugging
console.log(`Desktop Playwright config: CI=${isCI}`);
console.log(`Current working directory: ${process.cwd()}`);
console.log(`Test directory: ./e2e`);

const config: PlaywrightTestConfig = {
  testDir: './e2e',
  
  // Don't run tests in files in parallel since we have limited workers
  fullyParallel: false,
  
  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: isCI,
  
  // Retry on CI only
  retries: isCI ? 2 : 0,
  
  // Opt out of parallel tests on CI for Electron (can be resource intensive)
  workers: isCI ? 1 : 2,
  
  // Reporter to use
  reporter: isCI 
    ? [['blob', { outputDir: 'blob-report' }], ['list']]
    : [['html', { open: 'never' }], ['list']],
  
  // Global timeout for each test
  timeout: 60000, // Electron apps can be slower to start
  
  // Expect timeout for assertions
  expect: {
    timeout: 10000,
  },
  
  use: {
    // Collect trace when retrying the failed test
    trace: isCI ? 'on-first-retry' : 'retain-on-failure',
    
    // Take screenshot on failure
    screenshot: 'only-on-failure',
    
    // Record video on retry
    video: 'retain-on-failure',
    
    // Test ID attribute for better element selection
    testIdAttribute: 'data-testid',
  },
  
  // Configure projects for different scenarios
  projects: [
    {
      name: 'electron-main',
      testDir: './e2e',
      testMatch: '**/*.spec.ts',
      use: {
        // Electron-specific configuration will be handled in global setup
      },
    },
  ],
  
  // Global setup for Electron app
  globalSetup: './e2e/global-setup.ts',
  
  // Output directory for test artifacts
  outputDir: 'test-results/',
};

export default config; 