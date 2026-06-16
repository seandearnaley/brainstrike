# E2E Testing with Playwright

This directory contains end-to-end tests using Playwright for the Brainstrike web application.

## Running Tests

We've simplified the testing approach to make it easier to run tests in different environments:

### From the web app directory (`apps/web`)

```bash
# Run all tests
pnpm test:e2e

# Run tests with UI mode (for debugging)
pnpm test:e2e:ui

# Run tests with debug mode
pnpm test:e2e:debug
```

### From the root directory

```bash
# Run all tests 
pnpm test:e2e

# Run tests with UI mode
pnpm test:e2e:ui

# Run tests with debug mode
pnpm test:e2e:debug
```

## Configuration

Tests are configured in `playwright.config.ts` at the root of the web application. The configuration:

- Automatically handles both CI and local development environments
- Starts a development server if one is not already running
- Uses headless mode in CI and headed mode in local development
- Captures screenshots on failures and videos on retries

## Test Files

### Core Application Tests
- `layout.test.ts` - Basic application layout and navigation tests
- `file-explorer.test.ts` - File explorer functionality tests
- `file-explorer-filters.test.ts` - File type filtering tests
- `theme-switching.test.ts` - Theme switching functionality tests
- `complete-workflow.test.ts` - End-to-end workflow tests

### Layout Persistence Tests
- `layout-persistence.test.ts` - Comprehensive IDE layout persistence tests
  - Panel visibility persistence across page reloads
  - Panel resize persistence
  - Complex layout state management
  - Error handling and recovery scenarios
### Test Utilities
- `utils/layout-helpers.ts` - Helper functions for layout testing
- `utils/mock-fs.ts` - File system mocking utilities

## Writing Tests

Place your test files in this directory with the `.test.ts` extension. See existing tests for examples.

Why `.test.ts` in 2025? Consistency across unit, integration, and E2E tests improves discoverability and tooling. Playwright supports both `.spec` and `.test`, and we standardize on `.test` to:
- align naming with Vitest and our unit/integration conventions;
- keep runner-agnostic file names (no leaky abstraction of the test framework);
- simplify TypeScript and tooling exclude/include globs.

### Layout Testing Patterns

When writing layout tests, use the helper utilities from `utils`. The `resetAppState` helper ensures localStorage is cleared before tests:

```typescript
import { getPanelElements, waitForAppLoad } from './utils/layout-helpers';
import { resetAppState } from './utils/app-state';

test('my layout test', async ({ page }) => {
  await page.goto('/');
  await waitForAppLoad(page);
  await resetAppState(page);
  await page.reload();
  await waitForAppLoad(page);
  
  const elements = getPanelElements(page);
  // Your test logic here
});
```

## CI Integration

Tests run automatically in CI via GitHub Actions. The configuration:

- Builds the application before running tests
- Runs tests in headless mode
- Saves test artifacts for later inspection

## Troubleshooting

If you encounter issues:

1. Ensure Playwright is installed: `pnpm exec playwright install`
2. Check if Vite is running correctly: `pnpm dev` 
3. Try running with debug mode: `pnpm test:e2e:debug`
4. Inspect the Playwright report: `pnpm exec playwright show-report`
