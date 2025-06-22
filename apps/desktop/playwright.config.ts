import type { PlaywrightTestConfig } from '@playwright/test';
import { 
  getEnvironmentConfig, 
  logEnvironmentConfig, 
  validateEnvironmentConfig,
  getCILaunchArgs 
} from '@brainstrike/config/playwright-environment';

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
        args: getCILaunchArgs()
      }
    }),
    
    // Collect trace when retrying failed tests
    trace: config.isCI ? 'on-first-retry' : 'retain-on-failure',
    
    // Take screenshot on failure
    screenshot: 'only-on-failure',
    
    // Record video on retry
    video: 'retain-on-failure',
    
    // Use data-testid for element selection
    testIdAttribute: 'data-testid',
  },
  
  // Test match patterns
  testMatch: [
    '**/*.spec.ts',
    '**/*.test.ts'
  ],
  
  // Test ignore patterns
  testIgnore: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**'
  ],
  
  // Global setup for Electron app
  globalSetup: './e2e/global-setup.ts',
  
  // Output directory for test artifacts
  outputDir: 'blob-report/',
};

export default playwrightConfig; 