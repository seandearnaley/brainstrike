# Electron Test Fixtures

This directory contains Playwright fixtures for optimized Electron testing.

## Worker-Scoped Electron Fixture

The `electron-fixture.ts` implements a worker-scoped fixture that launches Electron once per worker instead of per test. This provides significant performance improvements:

- **Before**: ~18 launches (one per test) × 6s = ~108s launch overhead
- **After**: 2 launches (one per worker) × 6s = ~12s launch overhead
- **Savings**: ~96s (~5 minutes) per test run

## Usage

```typescript
import { test, expect } from './fixtures/electron-fixture';

test.describe('My Feature', () => {
  test('should work', async ({ electronApp, electron, homePage, window }) => {
    // electronApp is shared across tests in the same worker
    // homePage is a fresh instance for each test
    expect(electronApp.window).toBeTruthy();
    await homePage.shouldBeVisible();

    // Optional: restart Electron without leaving the worker
    await electron.restart();

    // Optional: reuse the renderer after restart
    await window.waitForEvent('load');
  });
});
```

## Migration Pattern

To migrate existing tests:

1. Replace `import { test, expect } from '@playwright/test'` with `import { test, expect } from './fixtures/electron-fixture'`
2. Remove `beforeEach`/`afterEach` hooks that launch/close Electron
3. Add `{ electronApp, homePage }` parameters to test functions
4. Replace `appContext` references with `electronApp` or `window` (the pre-reset renderer page)
5. Replace manual `homePage` instantiation with the fixture parameter
6. Annotate specs that must keep renderer state with
   `test.info().annotations.push({ type: 'preserve-electron-state' })`

## Benefits

- Faster test execution (~5min savings)
- Reduced flakiness from repeated app launches
- Automatic cleanup between test files
- Consistent app state initialization with per-test renderer resets
- Opt-in renderer preservation for persistence scenarios
