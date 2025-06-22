import type { PlaywrightTestConfig } from '@playwright/test';

// Environment detection
const isCodex = !!process.env['CODEX_ENV']; // Custom env var for Codex
const isGitHubActions = !!process.env['GITHUB_ACTIONS']; // GitHub Actions standard env var
const isCI = !!process.env['CI'] || isCodex || isGitHubActions; // General CI detection

// Worker configuration based on environment
const getWorkerCount = () => {
  if (isCodex) return 1; // Codex has very limited resources
  if (isGitHubActions) return 2; // GitHub Actions free runners have 2 cores
  if (isCI) return 1; // Other CI environments, be conservative
  return 2; // Local development default
};

// Timeout configuration based on environment
const getGlobalTimeout = () => {
  if (isCodex) return 10 * 60 * 1000; // 10 minutes for Codex (15 min limit)
  if (isCI) return 15 * 60 * 1000; // 15 minutes for other CI
  return 0; // No global timeout for local development
};

// Log environment detection for debugging
console.log(`Desktop Playwright config:`);
console.log(`  Codex: ${isCodex}`);
console.log(`  GitHub Actions: ${isGitHubActions}`);
console.log(`  General CI: ${isCI}`);
console.log(`  Workers: ${getWorkerCount()}`);
console.log(`  Global timeout: ${getGlobalTimeout() / 1000}s`);

const config: PlaywrightTestConfig = {
  testDir: './e2e',
  
  // Global timeout based on environment
  globalTimeout: getGlobalTimeout(),
  
  // Per-test timeout - Electron apps can be slower to start
  timeout: 60_000,
  
  // Don't run tests in parallel - Electron can be resource intensive
  fullyParallel: false,
  
  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: isCI,
  
  // Retry strategy based on environment
  retries: isCI ? (isCodex ? 1 : 2) : 0, // Fewer retries for Codex to save time
  
  // Worker count based on environment capabilities
  workers: getWorkerCount(),
  
  // Reporter configuration
  reporter: isCI 
    ? [['blob', { outputDir: 'blob-report' }], ['list']]
    : [['html', { open: 'never' }], ['list']],
  
  // Expect timeout for assertions
  expect: {
    timeout: 10000,
  },
  
  use: {
    // Headless mode for CI environments
    headless: isCI,
    
    // CI-optimized launch options for resource-constrained environments
    ...(isCI && {
      launchOptions: {
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage', // /dev/shm is tiny in CI
          '--disable-setuid-sandbox',
          '--disable-gpu',
          ...(isCodex ? ['--disable-web-security'] : []), // Extra flags for Codex
        ]
      }
    }),
    
    // Collect trace when retrying failed tests
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
  outputDir: 'blob-report/',
};

export default config; 