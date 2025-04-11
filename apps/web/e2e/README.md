# E2E Testing with Playwright

This directory contains end-to-end tests using Playwright for the Brainstrike web application.

## Running Tests

We've simplified the testing approach to make it easier to run tests in different environments:

### From the web app directory (`apps/web`)

```bash
# Run all tests
npm run test:e2e

# Run tests with UI mode (for debugging)
npm run test:e2e:ui

# Run tests with debug mode
npm run test:e2e:debug
```

### From the root directory

```bash
# Run all tests 
npm run test:e2e

# Run tests with UI mode
npm run test:e2e:ui

# Run tests with debug mode
npm run test:e2e:debug
```

## Configuration

Tests are configured in `playwright.config.ts` at the root of the web application. The configuration:

- Automatically handles both CI and local development environments
- Starts a development server if one is not already running
- Uses headless mode in CI and headed mode in local development
- Captures screenshots on failures and videos on retries

## Writing Tests

Place your test files in this directory with the `.spec.ts` extension. See existing tests for examples.

## CI Integration

Tests run automatically in CI via GitHub Actions. The configuration:

- Builds the application before running tests
- Runs tests in headless mode
- Saves test artifacts for later inspection

## Troubleshooting

If you encounter issues:

1. Ensure Playwright is installed: `npx playwright install`
2. Check if Vite is running correctly: `npm run dev` 
3. Try running with debug mode: `npm run test:e2e:debug`
4. Inspect the Playwright report: `npx playwright show-report` 