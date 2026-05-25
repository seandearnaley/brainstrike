---
title: Vitest Browser Mode Migration
sidebar_position: 6
---

# Vitest 4 Browser Mode Migration Guide

**Date:** November 2025
**Status:** Implementation Complete (POC)
**Related Issue:** BST-27

## Overview

This guide documents the migration to Vitest 4 Browser Mode in the BrainStrike monorepo. Browser Mode enables tests to run in real browser environments (Chromium via Playwright), providing full support for WASM and IndexedDB - features that were previously difficult or impossible to test with jsdom/Happy DOM.

## What Changed in Vitest 4

### Breaking Changes

1. **Provider Packages Separated**: `@vitest/browser` is deprecated. Provider-specific packages are now required:
   - `@vitest/browser-playwright` (recommended)
   - `@vitest/browser-webdriver`

2. **Provider Configuration**: Provider config changed from string to function:
   ```typescript
   // Before (Vitest 3.x)
   provider: 'playwright'

   // After (Vitest 4.x)
   import { playwright } from '@vitest/browser-playwright';
   provider: playwright({ launchOptions: { ... } })
   ```

3. **Test Projects Pattern**: Mixed environments (browser + jsdom) now use the `projects` configuration pattern.

## Implementation Summary

### Files Created

| File | Purpose |
|------|---------|
| `packages/config/src/vitest-browser.ts` | Shared browser test configuration utilities |
| `packages/db/__tests__/pglite-browser.browser.test.ts` | PGlite WASM/IndexedDB POC tests |
| `packages/storage/src/__tests__/web-storage-adapter.browser.test.ts` | localStorage/sessionStorage POC tests |

### Files Modified

| File | Changes |
|------|---------|
| `packages/db/vitest.config.mts` | Added test projects pattern with browser project |
| `packages/storage/vitest.config.mts` | Added test projects pattern with browser project |
| `packages/db/package.json` | Updated vitest, added @vitest/browser-playwright |
| `packages/storage/package.json` | Updated vitest, added @vitest/browser-playwright |
| `package.json` (root) | Added test:browser scripts |
| `turbo.jsonc` | Added test:browser task |
| `.github/workflows/test.yml` | Added browser-tests CI job |

## Quick Start

### Running Browser Tests

```bash
# Run all browser tests across monorepo
pnpm test:browser

# Run browser tests for specific package
pnpm test:browser:db
pnpm test:browser:storage

# Run browser tests directly in a package
cd packages/db
pnpm test:browser

# Run both unit and browser tests
pnpm test:all
```

### Writing Browser Tests

1. **File Naming Convention**: Use `.browser.test.ts` suffix
   ```
   packages/db/__tests__/pglite-browser.browser.test.ts
   ```

2. **Test Structure**: Same as regular Vitest tests
   ```typescript
   import { describe, expect, it, beforeAll, afterAll } from 'vitest';

   describe('Feature in Browser', () => {
     it('should work with real browser APIs', () => {
       // Real IndexedDB, localStorage, WASM all work!
       expect(typeof indexedDB).toBe('object');
     });
   });
   ```

3. **No Mocking Required**: Browser tests have access to real APIs
   ```typescript
   // This works in browser mode - no mocks needed!
   const db = new PGlite('idb://my-database');
   await db.waitReady;
   ```

## Configuration Reference

### Vitest Config with Projects Pattern

```typescript
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      // Existing unit tests (jsdom)
      {
        name: 'unit',
        test: {
          environment: 'jsdom',
          include: ['**/*.test.{ts,tsx}'],
          exclude: ['**/*.browser.test.{ts,tsx}'],
        },
      },
      // New browser tests
      {
        name: 'browser',
        test: {
          browser: {
            enabled: true,
            provider: playwright({
              launchOptions: {
                args: process.env.CI
                  ? ['--no-sandbox', '--disable-dev-shm-usage']
                  : [],
              },
            }),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
          include: ['**/*.browser.test.{ts,tsx}'],
          hookTimeout: 30000,
          testTimeout: 30000,
        },
      },
    ],
  },
});
```

### CI Configuration

Browser tests run in a parallel job to avoid blocking the main test pipeline:

```yaml
browser-tests:
  runs-on: ubuntu-latest
  timeout-minutes: 15
  needs: build
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
    - run: corepack enable
    - run: pnpm install --frozen-lockfile
    - uses: actions/cache@v4
      with:
        path: ~/.cache/ms-playwright
        key: playwright-${{ runner.os }}-${{ hashFiles('**/pnpm-lock.yaml') }}
    - run: npx playwright install chromium --with-deps
    - run: pnpm test:browser
```

## Migration Checklist

When migrating existing tests to browser mode:

### 1. Update Package Dependencies

```bash
cd packages/your-package
pnpm add -D vitest@^4.0.14 @vitest/browser-playwright@^4.0.14
```

### 2. Update Vitest Config

Add the projects pattern to support mixed environments. See [Configuration Reference](#configuration-reference).

### 3. Create Browser Tests

1. Identify tests that need real browser APIs (WASM, IndexedDB, localStorage)
2. Create new files with `.browser.test.ts` suffix
3. Remove mocks and use real APIs directly

### 4. Add Package Scripts

```json
{
  "scripts": {
    "test": "vitest run --project unit",
    "test:browser": "vitest run --project browser",
    "test:all": "vitest run"
  }
}
```

### 5. Verify Tests Pass

```bash
pnpm test:browser
```

## Troubleshooting

### Common Issues

**Issue: "Cannot find module '@vitest/browser-playwright'"**
```bash
pnpm add -D @vitest/browser-playwright@^4.0.14
```

**Issue: Browser tests timeout in CI**
- Increase timeouts: `hookTimeout: 30000`, `testTimeout: 30000`
- Add CI-specific Chrome args: `--no-sandbox`, `--disable-dev-shm-usage`

**Issue: "Playwright browsers not installed"**
```bash
npx playwright install chromium --with-deps
```

**Issue: Tests pass locally but fail in CI**
- Ensure Chrome args include `--disable-setuid-sandbox` and `--disable-features=VizDisplayCompositor`
- Check CI runner has sufficient memory

### Debugging Browser Tests

```bash
# Run in headed mode (visible browser)
pnpm vitest --browser.headless=false

# Run specific test file
pnpm vitest run path/to/test.browser.test.ts --project browser

# Enable Playwright traces (set in config)
trace: 'on-first-retry'
```

## Best Practices

### When to Use Browser Tests

**Use browser mode for:**
- WASM loading and execution (PGlite, embedding models)
- IndexedDB operations and persistence
- localStorage/sessionStorage testing
- Web Worker functionality
- Real DOM manipulation and events

**Keep using jsdom for:**
- Pure logic tests
- React hooks without browser dependencies
- Utility functions
- Tests that don't need real browser APIs

### Test Isolation

Browser tests share browser state. Always clean up:

```typescript
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // Delete IndexedDB databases if needed
});

afterAll(async () => {
  // Close database connections
  if (db) await db.close();
});
```

### Performance Considerations

- Browser tests are ~2-3x slower than jsdom tests
- Use parallel instances when possible
- Consider test splitting: fast unit tests + comprehensive browser tests
- Browser test CI job runs in parallel with other jobs

## POC Results

### Storage Browser Tests ✅ PASSING

The POC validates that Vitest 4 Browser Mode works correctly:
- ✅ Real localStorage API access (not mocked)
- ✅ Real sessionStorage API access
- ✅ CRUD operations with actual browser storage
- ✅ JSON serialization patterns
- ✅ Special characters handling
- ✅ Performance baseline (100 operations in 0.30ms!)
- ✅ **13 tests passed** in Chromium browser

### PGlite Browser Tests ⚠️ KNOWN ISSUE

PGlite WASM loading requires additional investigation:
- ⚠️ `Invalid FS bundle size: 0 !== 4938110` error
- This is a known [PGlite/Vite compatibility issue](https://github.com/electric-sql/pglite/issues/409)
- The issue is with how Vite pre-bundles the WASM filesystem
- `optimizeDeps.exclude` and `deps.optimizer.web.exclude` don't fully resolve it
- ✅ IndexedDB availability test passes (confirming real browser environment)

**Workarounds being investigated:**
1. Using PGlite from CDN in browser tests
2. Custom Vite plugin to handle WASM loading
3. Separate browser test setup without Vite dependency optimization

## Known Issues

### js-tokens Module Warning

Browser tests may show an unrelated warning:
```
SyntaxError: The requested module 'js-tokens/index.js' does not provide an export named 'default'
```

This is a module resolution issue in browser mode that doesn't affect test results. Tests pass despite this warning.

### Project Filtering

The `--project` flag may not work correctly with inline project definitions. Use file pattern matching instead:
```json
{
  "test:browser": "vitest run path/to/test.browser.test.ts"
}
```

## References

- [Vitest 4 Browser Mode Documentation](https://vitest.dev/guide/browser/)
- [Vitest Browser Configuration](https://vitest.dev/guide/browser/config)
- [Playwright Documentation](https://playwright.dev/)
- [BrainStrike Research Document](/testing/vitest-browser-mode-research)
- [Jira Ticket BST-27](https://brainstrike.atlassian.net/browse/BST-27)
