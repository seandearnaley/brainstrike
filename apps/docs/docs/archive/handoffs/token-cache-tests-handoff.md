---
title: "Token Cache Tests Handoff"
---

# Token Cache Testing Handoff

> **Date**: 2025-12-07
> **Author**: Claude Code
> **Status**: Ready for implementation
> **Priority**: High - Hardening critical infrastructure

## Executive Summary

The token cache system was recently fixed to resolve a render loop bug that prevented token counts from updating in the UI. The fix uses a **ref pattern** to maintain stable function references across renders. This document outlines the remaining test coverage needed to harden this critical feature.

---

## Context

### What is the Token Cache?

The token cache is a persistent caching system that stores token counts for files. It consists of:

1. **Hot Cache** (in-memory) - Fast lookups during a session
2. **Cold Cache** (PGlite/SQLite) - Persists across sessions
3. **Background Worker** - Counts tokens without blocking UI
4. **Integration Hook** - Connects file selection to indexing

### Recent Fix (2025-12-07)

A render loop bug was fixed in `use-background-token-indexer-integration.ts`. The problem:

```
Effect depends on tokenCache object → updateHotCache bumps cacheVersion
→ context object changes → effect re-runs → infinite loop
```

**Solution**: Use refs to maintain stable function references:

```typescript
// Stable refs for tokenCache functions to avoid re-render loops
const tokenCacheRef = useRef(tokenCache);
tokenCacheRef.current = tokenCache;

// Extract primitives for effect dependencies
const tokenCacheIsReady = tokenCache?.isReady ?? false;

useEffect(() => {
  const cache = tokenCacheRef.current;
  // ... use cache via ref
}, [selectedFiles, tokenCacheIsReady]); // primitives only
```

---

## Current Test Coverage

### Covered ✅

| File | Tests | Coverage |
|------|-------|----------|
| `use-background-token-indexer-integration.test.tsx` | 18 | Hot cache updates, edge cases, ref stability |
| `use-background-token-indexer.test.tsx` | 4 | Worker interactions, error handling |
| `token-cache-store.test.ts` | 19 | CRUD operations, batch ops, stats |
| `file-hasher.test.ts` | 23 | Hashing, cache key creation |

### Not Covered ❌

| File | Priority | Reason |
|------|----------|--------|
| `use-token-cache.ts` | **Critical** | Main hook with no tests |
| `use-persistent-token-cache.ts` | High | Bridge hook with no tests |
| `token-cache-context.tsx` | Medium | Provider with no tests |
| E2E flows | High | No Playwright tests for token counts |

---

## Test Implementation Plan

### Phase 1: Unit Tests (Critical)

#### 1.1 `use-token-cache.ts` Tests

**Location**: `packages/token-cache/src/__tests__/use-token-cache.test.tsx`

```typescript
// PROMPT FOR IMPLEMENTATION:
// Create comprehensive unit tests for the useTokenCache hook.
// This hook manages hot cache (in-memory) and cold cache (PGlite)
// with background worker integration.

describe('useTokenCache', () => {
  describe('getTokenCount', () => {
    it('returns cached value from hot cache immediately');
    it('returns null and triggers background count when not cached');
    it('does not re-trigger count for pending requests');
    it('updates hot cache after successful count');
    it('calls onTokenResolved callback with correct values');
  });

  describe('hot cache management', () => {
    it('updateHotCache adds entry and bumps version');
    it('clearHotCache removes all entries');
    it('invalidate removes specific entries');
    it('preloadFolder populates hot cache from store');
  });

  describe('cache versioning', () => {
    it('increments cacheVersion when hot cache updates');
    it('debounces rapid version updates (VERSION_DEBOUNCE_MS)');
    it('does not update version after unmount');
  });

  describe('counting mode changes', () => {
    it('clears hot cache when countingMode changes');
    it('only uses cache entries matching current countingMode');
  });

  describe('getTotalTokens', () => {
    it('returns sum from store for given file paths');
    it('returns 0 for empty file paths');
  });

  describe('queueForCounting', () => {
    it('queues multiple files for background counting');
    it('includes fileSize and mtimeMs when provided');
  });
});
```

**Key Implementation Details**:
- Mock `TokenCacheStore`, `FileHasher`, and `workerPool`
- Test the debounce behavior (VERSION_DEBOUNCE_MS = 50ms)
- Verify content hash validation logic
- Test the cleanup effect on unmount

#### 1.2 `use-persistent-token-cache.ts` Tests

**Location**: `packages/file-explorer-ui/src/__tests__/use-persistent-token-cache.test.tsx`

```typescript
// PROMPT FOR IMPLEMENTATION:
// Create tests for the usePersistentTokenCache bridge hook.
// This hook integrates the persistent cache with the preview panel.

describe('usePersistentTokenCache', () => {
  describe('with persistent cache available', () => {
    it('returns token count from hot cache when available');
    it('returns undefined when count is loading');
    it('passes content to trigger counting when not cached');
    it('returns cacheVersion from context');
  });

  describe('with persistent cache unavailable (fallback)', () => {
    it('uses in-memory cache when context is null');
    it('triggers tokenCounting.countTokens for new files');
    it('falls back to heuristic on counting error');
    it('calls onTokenResolved after counting completes');
  });

  describe('content accessibility', () => {
    it('skips counting for "File not accessible" content');
    it('skips counting for "Binary file" content');
  });
});
```

### Phase 2: Integration Tests (High Priority)

#### 2.1 Full Token Cache Flow

**Location**: `packages/file-explorer-ui/src/__tests__/token-cache-flow.integration.test.tsx`

```typescript
// PROMPT FOR IMPLEMENTATION:
// Create integration tests for the complete token counting flow.
// Test from file selection through to UI update.

describe('Token Cache Integration Flow', () => {
  describe('file selection to token display', () => {
    it('shows loading state initially');
    it('displays token count after indexing completes');
    it('updates total tokens in preview panel header');
    it('persists counts across component remount');
  });

  describe('cache invalidation', () => {
    it('re-counts when file content changes (different hash)');
    it('uses cached count when content unchanged');
    it('clears cache when counting mode changes');
  });

  describe('multi-folder scenarios', () => {
    it('preloads cache for each selected folder');
    it('handles files from different folders correctly');
    it('maintains separate counts per folder');
  });
});
```

#### 2.2 Provider Integration

**Location**: `packages/file-explorer-ui/src/__tests__/token-cache-provider.integration.test.tsx`

```typescript
describe('TokenCacheProvider', () => {
  it('provides context to child components');
  it('initializes store and worker on mount');
  it('cleans up worker on unmount');
  it('handles store initialization failure gracefully');
});
```

### Phase 3: E2E Tests (High Priority)

#### 3.1 Web Token Counting

**Location**: `apps/web/e2e/token-counting.spec.ts`

```typescript
// PROMPT FOR IMPLEMENTATION:
// Create Playwright E2E tests for token counting in the web app.

import { test, expect } from '@playwright/test';

test.describe('Token Counting - Web', () => {
  test('displays token counts for selected files', async ({ page }) => {
    // 1. Navigate to file explorer
    // 2. Select a folder with known files
    // 3. Select files in the tree
    // 4. Verify token counts appear in preview panel
    // 5. Verify total tokens in header
  });

  test('token counts persist after page reload', async ({ page }) => {
    // 1. Select files and wait for counts
    // 2. Reload page
    // 3. Re-select same files
    // 4. Verify counts appear immediately (from cache)
  });

  test('token counts update when switching counting mode', async ({ page }) => {
    // 1. Select files with heuristic mode
    // 2. Note the counts
    // 3. Switch to accurate mode
    // 4. Verify counts are recalculated
  });
});
```

#### 3.2 Electron Token Counting

**Location**: `apps/desktop/e2e/token-counting.spec.ts`

```typescript
test.describe('Token Counting - Electron', () => {
  test('counts tokens for local files', async ({ electronApp }) => {
    // 1. Open a local folder
    // 2. Select files
    // 3. Verify token counts appear
    // Note: Electron uses IPC for file reading
  });

  test('handles large files without UI freeze', async ({ electronApp }) => {
    // 1. Select a large file (>1MB)
    // 2. Verify UI remains responsive
    // 3. Verify count eventually appears
  });
});
```

### Phase 4: Edge Case Tests

#### 4.1 Error Scenarios

```typescript
describe('Token Cache Error Handling', () => {
  it('recovers from worker crash');
  it('handles store write failures');
  it('handles hasher initialization failure');
  it('continues after individual file errors');
});
```

#### 4.2 Performance Edge Cases

```typescript
describe('Token Cache Performance', () => {
  it('handles 1000+ files without UI lag');
  it('debounces rapid selection changes');
  it('batches worker messages efficiently');
  it('does not cause render loops on cache update');
});
```

#### 4.3 Content Edge Cases

```typescript
describe('Token Cache Content Handling', () => {
  it('handles empty files');
  it('handles files with only whitespace');
  it('handles files with unicode content');
  it('handles very long single lines');
  it('handles binary content detection');
});
```

---

## Implementation Tips

### Setting Up Mocks

**Worker Mock Pattern**:
```typescript
class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(url: string) {
    mockWorkers.push(this);
  }

  postMessage(message: unknown) {
    // Capture for assertions
  }

  terminate() {}
}

vi.stubGlobal('Worker', MockWorker);
```

**Store Mock Pattern**:
```typescript
const createStoreMock = () => ({
  get: vi.fn(async () => null),
  set: vi.fn(async () => {}),
  getBatch: vi.fn(async () => new Map()),
  // ... other methods
});
```

### Testing Ref Stability

To verify the ref pattern prevents render loops:

```typescript
it('does not cause render loops when cacheVersion changes', () => {
  let renderCount = 0;

  const { rerender } = renderHook(() => {
    renderCount++;
    return useBackgroundTokenIndexerIntegration({...});
  });

  // Simulate many cache updates
  for (let i = 0; i < 100; i++) {
    act(() => capturedOnFileIndexed?.(fileKey, i));
  }

  // Render count should be bounded, not 100+
  expect(renderCount).toBeLessThan(10);
});
```

### Testing Async Effects

```typescript
await act(async () => {
  await vi.runAllTimersAsync();
});
```

### Debugging Test Failures

1. **Check for fake timers**: Many tests use `vi.useFakeTimers()`
2. **Verify mock captures**: Callbacks are captured on first render
3. **Check effect dependencies**: Look for missing deps causing stale closures
4. **Use logger output**: Tests output log messages for debugging

---

## File Locations Reference

```
packages/
├── token-cache/
│   └── src/
│       ├── __tests__/
│       │   ├── file-hasher.test.ts          ✅ 23 tests
│       │   ├── token-cache-store.test.ts    ✅ 19 tests
│       │   ├── use-background-token-indexer.test.tsx  ✅ 4 tests
│       │   └── use-token-cache.test.tsx     ❌ NEEDS CREATION
│       ├── use-token-cache.ts               # Main hook
│       ├── use-background-token-indexer.ts  # Worker hook
│       ├── token-cache-store.ts             # PGlite store
│       └── file-hasher.ts                   # xxHash64 hasher
│
├── file-explorer-ui/
│   └── src/
│       ├── __tests__/
│       │   ├── use-background-token-indexer-integration.test.tsx  ✅ 18 tests
│       │   ├── use-persistent-token-cache.test.tsx  ❌ NEEDS CREATION
│       │   └── token-cache-flow.integration.test.tsx  ❌ NEEDS CREATION
│       ├── use-background-token-indexer-integration.ts  # Integration hook
│       ├── use-persistent-token-cache.ts    # Bridge hook
│       └── token-cache-context.tsx          # React context
│
apps/
├── web/e2e/
│   └── token-counting.spec.ts               ❌ NEEDS CREATION
└── desktop/e2e/
    └── token-counting.spec.ts               ❌ NEEDS CREATION
```

---

## Acceptance Criteria

### For Unit Tests
- [ ] `use-token-cache.ts` has 90%+ coverage
- [ ] `use-persistent-token-cache.ts` has 90%+ coverage
- [ ] All edge cases for error handling covered
- [ ] Debounce behavior verified

### For Integration Tests
- [ ] Full flow from selection → count → display tested
- [ ] Cache invalidation scenarios covered
- [ ] Multi-folder scenarios tested

### For E2E Tests
- [ ] Web app token counting works end-to-end
- [ ] Electron app token counting works end-to-end
- [ ] Persistence across reload verified
- [ ] Performance acceptable (no UI lag)

### Quality Gates
- [ ] All tests pass: `pnpm test`
- [ ] Type check passes: `pnpm type-check`
- [ ] Lint passes: `pnpm lint`
- [ ] No console errors in tests

---

## Estimated Effort

| Phase | Effort | Priority |
|-------|--------|----------|
| Phase 1: Unit Tests | 4-6 hours | Critical |
| Phase 2: Integration Tests | 3-4 hours | High |
| Phase 3: E2E Tests | 4-6 hours | High |
| Phase 4: Edge Cases | 2-3 hours | Medium |

**Total**: 13-19 hours

---

## Questions?

If you have questions about the implementation:

1. **Architecture**: Check `docs/architecture/token-cache.md` (if exists)
2. **Recent changes**: Review commits on `tweaks-for-progress` branch
3. **Existing patterns**: Look at `use-background-token-indexer-integration.test.tsx` for mock patterns

Good luck! 🚀
