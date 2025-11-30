/**
 * Playwright merge configuration for combining web and desktop test reports
 * ES module version for compatibility with "type": "module" in package.json
 *
 * This config is used specifically for merging blob reports from different test directories:
 * - apps/web/e2e (web application tests)
 * - apps/desktop/e2e (desktop application tests)
 *
 * This solves the error: "Blob reports being merged were recorded with different test directories"
 */
export default {
  // Set a common test directory for merged reports
  // This helps resolve path conflicts between different source directories
  testDir: './merged-tests',

  // Configure reporter for the merged output
  reporter: [
    [
      'html',
      {
        outputDir: 'playwright-report-merged',
        open: 'never',
        attachmentsBaseURL: 'data/',
      },
    ],
    ['list'],
  ],

  // Timeout and retry settings
  timeout: 30_000,
  retries: 0, // Don't retry during merge

  // Basic test configuration
  use: {
    testIdAttribute: 'data-testid',
  },

  // Define projects to handle different test sources
  // This allows the merge to understand both web and desktop test structures
  projects: [
    {
      name: 'web-tests',
      testDir: './apps/web/e2e',
      use: {
        baseURL: 'http://localhost:5173',
      },
    },
    {
      name: 'desktop-tests',
      testDir: './apps/desktop/e2e',
      use: {
        // Desktop-specific configuration
      },
    },
  ],
};
