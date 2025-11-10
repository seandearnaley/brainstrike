# Test Validation Guide

This guide explains how to validate the newly added unit tests locally.

## ⚠️ Important Note

Due to network restrictions in the CI environment, the tests could not be executed during development. **Please run these tests locally to validate they work correctly.**

## Quick Start

```bash
# Install all dependencies
pnpm install

# Run tests for all modified packages
pnpm test --filter @brainstrike/queue --filter @brainstrike/file-system --filter @brainstrike/storage --filter @brainstrike/types

# Or run each package individually (recommended for first run)
pnpm --filter @brainstrike/types test
pnpm --filter @brainstrike/queue test
pnpm --filter @brainstrike/storage test
pnpm --filter @brainstrike/file-system test
```

## Package-by-Package Validation

### 1. @brainstrike/types

**New test files:**
- `__tests__/embedding-constants.test.ts` (140+ lines, 24 tests)
- `__tests__/file-explorer-constants.test.ts` (350+ lines, 50+ tests)
- `__tests__/errors.test.ts` (enhanced with 250+ lines, 40+ new tests)

**Run:**
```bash
cd packages/types
pnpm test
```

**Expected:** All tests should pass, coverage should increase from ~25% to 80%+

**Common issues to watch for:**
- ✅ Bracket notation for index signatures (already fixed)
- ✅ No self-comparisons (already fixed)
- ✅ Unused variables removed (already fixed)

---

### 2. @brainstrike/queue

**New test files:**
- `test/browser-pqueue.spec.ts` (350+ lines, 35+ tests)
- `test/browser-workerpool.spec.ts` (650+ lines, 45+ tests)

**Run:**
```bash
cd packages/queue
pnpm test
```

**Expected:** All tests should pass, coverage should increase from ~28% to 80%+

**Tests cover:**
- Basic functionality, pause/resume/drain
- Progress event emission and multiple listeners
- Error handling and telemetry integration
- Bulk operations, concurrency limits
- Abort signal handling
- Mock implementations of transformers, workerpool

**Potential issues:**
- Transformers mocking - the tests mock `@huggingface/transformers` heavily
- Workerpool mocking - complex mock setup for worker pools
- Timing-dependent tests - use proper `waitFor` patterns

---

### 3. @brainstrike/file-system

**New test files:**
- `src/__tests__/electron-watchers.test.ts` (500+ lines, 40+ tests)

**Run:**
```bash
cd packages/file-system
pnpm test
```

**Expected:** All tests should pass, coverage should increase from ~50% to 80%+

**Tests cover:**
- startFsWatch: file/directory additions, modifications, removals
- startChokidarWatch: all event types with configuration
- Event filtering, error handling, stop functionality
- Mock filesystem operations with temp directories

**Potential issues:**
- File system operations - tests create real temp files/directories
- Timing/race conditions - uses `waitForCondition` helper with timeouts
- Chokidar mocking - tests mock both chokidar and fs.watch
- ✅ TypeScript types for fs.watch mock (already fixed)

**Watch for:**
- Tests should clean up temp directories in `afterEach`
- `waitForCondition` timeout is 1-3 seconds (may need adjustment on slow systems)

---

### 4. @brainstrike/storage

**Enhanced test file:**
- `src/__tests__/electron-storage-adapter.test.ts` (+250 lines, +30 tests)

**Run:**
```bash
cd packages/storage
pnpm test
```

**Expected:** All tests should pass, coverage should increase from ~50% to 80%+

**Tests cover:**
- Special characters (keys & values), unicode, emojis
- Concurrent operations (10+ parallel reads/writes)
- Corrupted JSON handling
- Directory creation for nested paths
- Electron import failures with graceful degradation
- Case sensitivity, numeric-like keys, insertion order

**Potential issues:**
- File system operations - creates temp storage files
- Electron mocking - mocks electron app.whenReady and app.getPath
- Concurrent operations - stress tests with 10+ parallel operations

---

## Expected Test Results

### Coverage Improvements

| Package | Before | Target | Tests Added |
|---------|--------|--------|-------------|
| @brainstrike/types | 25% | 80%+ | 114+ tests |
| @brainstrike/queue | 28.6% | 80%+ | 80+ tests |
| @brainstrike/file-system | 50% | 80%+ | 40+ tests |
| @brainstrike/storage | 50% | 80%+ | 30+ tests |

### Total Impact
- **264+ new test cases**
- **~3,000 lines of test code**
- **4 critical packages** significantly improved

---

## Common Test Patterns Used

### 1. Async/Await with Vitest
```typescript
it('should handle async operations', async () => {
  const result = await asyncFunction();
  expect(result).toBe(expected);
});
```

### 2. Mock Implementations
```typescript
vi.mock('module-name', () => ({
  function: vi.fn().mockReturnValue(value),
}));
```

### 3. Temporary File Cleanup
```typescript
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
});

afterEach(async () => {
  await fsPromises.rm(tempDir, { recursive: true, force: true });
});
```

### 4. Wait for Conditions
```typescript
async function waitForCondition(check: () => boolean, timeout = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timeout');
}
```

---

## Troubleshooting

### Tests Fail with "Module not found"
```bash
# Ensure all dependencies are installed
pnpm install
```

### Tests Timeout
- Increase timeout in individual test: `it('test', async () => {...}, 10000)`
- Check for hanging promises or event listeners
- Verify mock cleanup in `afterEach`

### File System Tests Fail
- Check temp directory permissions
- Verify cleanup in `afterEach` blocks
- Check for race conditions with file watchers

### Mock Tests Fail
- Check mock setup in `beforeEach`
- Verify mock reset in `afterEach`
- Check vi.restoreAllMocks() is called

---

## Next Steps After Validation

1. **Run full test suite:**
   ```bash
   pnpm test
   ```

2. **Check coverage:**
   ```bash
   pnpm test -- --coverage
   ```

3. **Run type-check:**
   ```bash
   pnpm type-check
   ```

4. **Run linter:**
   ```bash
   pnpm lint
   ```

5. **Full validation pipeline:**
   ```bash
   pnpm check
   ```

---

## Expected CI Results

Once pushed, CI should show:
- ✅ All lint checks pass (Biome)
- ✅ All type-check pass (TypeScript)
- ✅ All unit tests pass (Vitest)
- ✅ Coverage increased for 4 packages
- ✅ No regression in other packages

---

## Issues to Report

If tests fail, please report:
1. Which package/test file
2. Full error message and stack trace
3. Node version (`node --version`)
4. pnpm version (`pnpm --version`)
5. OS and environment details

Create an issue or comment on the PR with these details.

---

## Files Modified

```
packages/queue/test/
├── browser-pqueue.spec.ts          (NEW - 350 lines)
└── browser-workerpool.spec.ts      (NEW - 650 lines)

packages/file-system/src/__tests__/
└── electron-watchers.test.ts       (NEW - 500 lines)

packages/storage/src/__tests__/
└── electron-storage-adapter.test.ts (ENHANCED - +250 lines)

packages/types/__tests__/
├── embedding-constants.test.ts     (NEW - 140 lines)
├── file-explorer-constants.test.ts (NEW - 350 lines)
└── errors.test.ts                  (ENHANCED - +250 lines)
```

---

**Last Updated:** During test coverage enhancement initiative
**Branch:** `claude/enhance-unit-test-coverage-011CUyXXv2suEPnoSTnzmkNE`
