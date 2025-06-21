/**
 * Playwright merge configuration for combining web and desktop test reports
 * JavaScript version for better CI compatibility
 * 
 * This config is used specifically for merging blob reports from different test directories:
 * - apps/web/e2e (web application tests)
 * - apps/desktop/e2e (desktop application tests)
 * 
 * This solves the error: "Blob reports being merged were recorded with different test directories"
 */
module.exports = {
  // Set a common test directory for merged reports
  // This helps resolve path conflicts between different source directories
  testDir: './merged-tests',
  
  // Configure reporter for the merged output
  reporter: [
    ['html', { 
      outputDir: 'playwright-report-merged',
      open: 'never',
      attachmentsBaseURL: 'data/'
    }],
    ['list']
  ],
  
  // Timeout and retry settings
  timeout: 30000,
  retries: 0, // Don't retry during merge
  
  // Use settings compatible with both web and desktop tests
  use: {
    testIdAttribute: 'data-testid',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  
  // Define projects to handle different test types
  // This is the key part that allows merging reports from different directories
  projects: [
    {
      name: 'web-tests',
      testDir: './apps/web/e2e',
      use: {
        // Web-specific settings if needed
        baseURL: process.env.BASE_URL || 'http://127.0.0.1:8080',
      }
    },
    {
      name: 'desktop-tests', 
      testDir: './apps/desktop/e2e',
      use: {
        // Desktop-specific settings if needed
      }
    },
  ],
}; 