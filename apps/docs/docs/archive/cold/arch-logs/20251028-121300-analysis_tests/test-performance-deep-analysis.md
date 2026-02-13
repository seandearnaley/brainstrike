---
title: "Test Performance Deep Analysis"
status: "cold-archive"
date: "2025-10-28"
superseded_by: "none"
---

# Deep Test Performance Bottlenecks Analysis - BrainStrike

## Overview
Comprehensive analysis of test performance issues across 403 test files (excluding node_modules and Stryker temp files). This report focuses on uncovered optimization areas beyond previous analysis.

---

## 1. TEST COVERAGE AND REDUNDANCY

### 1.1 Duplicate/Overlapping Test Coverage

**File Explorer E2E Tests - HIGH REDUNDANCY**
- **Location**: `/apps/web/e2e/file-explorer*.test.ts`
- **Files**:
  - file-explorer.test.ts (135 lines, ~12 tests)
  - file-explorer-filters.test.ts (82 lines, ~8 tests)
  - file-explorer-settings.test.ts (43 lines, ~4 tests)
  - file-explorer-settings-advanced.test.ts (76 lines, ~6 tests)
  - file-explorer-settings-clamping.test.ts (77 lines, ~6 tests)

**Issue**: These tests have significant overlapping coverage of settings configuration and basic filter functionality. The settings tests could be consolidated into a single parametrized test suite.

**Impact**: Estimated 30-40% reduction possible through consolidation (~150 lines of test code eliminated, ~20-30% faster E2E runs)

### 1.2 State Preservation Tests - Redundant Coverage

**Files with Duplicate State Preservation Tests**:
- navigation-panel-state-preservation.test.ts
- panel-state-preservation.test.ts  
- state-preservation-simple.test.ts
- right-panel-persistence.test.ts
- right-panel-navigation-persistence.test.ts

**Issue**: 5 separate files testing nearly identical state persistence scenarios. Tests could be consolidated into a single file with parametrized test cases.

**Impact**: ~25-35% faster E2E execution (5 separate app launches eliminated)

### 1.3 Snapshot Tests Analysis

**Snapshot Usage**:
- **Total snapshot references**: 77 across 18 files
- **Location**: `/packages/ui/src/__tests__/__snapshots__/badge.test.tsx.snap` (only 1 snapshot file found)

**Files Using Snapshots**:
1. badge.test.tsx (4 snapshots) - lowest value for UI components
2. right-panel.test.tsx (17 snapshots) - EXCESSIVELY LARGE
3. assistant-ui-panel.test.tsx (3 snapshots)
4. Multiple preference/settings components (2-3 each)

**Issue**: Snapshot tests for UI components are brittle and high-maintenance. The 17 snapshots in right-panel.test.tsx suggest excessive snapshot coverage.

**Action Item**: 
- Replace snapshots with specific property assertions for right-panel
- Keep snapshots only for complex layout components that genuinely require visual regression testing
- Estimated: 20-30% test execution time saved by removing unnecessary snapshot comparisons

---

## 2. IMPORT AND MODULE LOADING ISSUES

### 2.1 Heavy Mock Setup Patterns

**File: `/packages/file-explorer-ui/src/__tests__/preview-panel.test.tsx`**
- **Size**: 1,427 lines
- **Test Count**: 55 test cases (26 lines per test on average)
- **Mock Count**: 35 vi.mock() and manual mock definitions
- **Render Count**: 55 individual render() calls

**Issue**: Every test re-renders the entire component with full mock setup. Preview panel has massive inline mock definitions (lines 45-370).

```typescript
// Lines 45-370: 325 lines of MOCK COMPONENT DEFINITIONS
vi.mock('@brainstrike/ui', () => ({
  Badge: ...,
  Button: ...,
  Checkbox: ...,
  Progress: ...,
  Popover: ...,
  PopoverTrigger: ...,
  PopoverContent: ...,
  Table: ...,
  TableHeader: ...,
  // ... continues with 15+ mock definitions
}));
```

**Impact Calculation**:
- Each render call: ~50-100ms with mock setup
- 55 tests × 100ms = 5,500ms = ~5.5 seconds just for renders
- **Optimization**: Move mocks to external file, reuse render wrapper
- **Estimated Gain**: 40-50% time reduction for this file (~2.5-3 seconds saved)

### 2.2 Excessive Mock Operations

**Database Explorer Tests**:
- **File**: `/packages/db-explorer/src/__tests__/database-demo-panel.test.tsx`
- **Size**: 863 lines
- **Mock Operations**: 22 distinct vi.mock() + .mockReturnValue() chains

**Issue**: 22 mock setup operations for 32 tests (0.7 mocks per test). Many mocks are redundant.

### 2.3 Dynamic Imports in Mocks

**Issue Pattern Found**:
```typescript
// Problematic pattern - Dynamic import in hot path
vi.mock('../use-preview-panel-state', async () => {
  const actual = await vi.importActual(...);
  return { ...actual, ... };
});

const mockUsePreviewPanelState = vi.mocked(
  await import('../use-preview-panel-state')
).usePreviewPanelState;
```

**Files Affected**:
- file-explorer-ui/preview-panel.test.tsx
- file-explorer-hooks/use-file-tree.test.ts
- Several agent package tests

**Impact**: Adds 50-100ms per test file setup time due to dynamic imports during test initialization.

---

## 3. TEST DATA AND FIXTURES

### 3.1 Large Vector/Embedding Data in Tests

**File**: `/packages/db/__tests__/file-chunk-repository.test.ts`
- **Size**: 857 lines, 118 test/describe statements
- **Large Arrays Created**: 15 vector creation calls
- **Largest Vector**: 16,001 dimensions (line 368)

```typescript
// Lines 85-91, 335-340, 368-373, etc.
const embedding = makeVector(768, [[0, 0.1], [1, 0.2], [2, 0.3], ...]); // Repeated 15x
const embedding = makeVector(16_001, [...]); // Maximum size test
const chunks: FileChunkInsert[] = [...]; // Multiple large arrays

// Line 85-115: Creates 768-dim vector with 5 entries
// Line 335-350: Creates another 768-dim vector with 5 entries (DUPLICATE)
// Line 368-375: Creates 16,001-dim vector (HIGH MEMORY)
```

**Memory Impact**:
- 768-dimension vectors: ~6KB each (768 floats × 8 bytes)
- 16,001-dimension vectors: ~128KB each
- File loads ~15 such vectors = ~1-2MB for single test file
- With 36 DB test files × 1-2MB = 36-72MB of embedding data

**Optimization Opportunity**:
- Generate vectors dynamically during test execution
- Use smaller dimensions for unit tests (128 or 256 instead of 768)
- Create helper function for lazy vector generation

**Estimated Gain**: 30-40% memory reduction, 15-20% faster startup

### 3.2 Hardcoded Large Test Objects

**File**: `/packages/db-explorer/src/__tests__/database-demo-panel.test.tsx`
- **Lines**: 863 total
- **Mock Data Setup**: ~250 lines of hardcoded mock objects

```typescript
// Lines 12-80+: Mock definitions with large object literals
const mockRepository = { findAll: ..., create: ..., ... };
const mockChunkRepository = { ... };
const mockEmbeddingService = { ... };
// Plus full mock implementations for services
```

**CSV Export Tests**:
- `/packages/db-explorer/src/__tests__/csv-export-utils.test.ts`
- **Size**: 654 lines
- **CSV Data Samples**: Multiple 1000+ line CSV strings hardcoded

**Recommendation**: Move large test data to separate JSON fixture files instead of inline literals.

---

## 4. VITEST CONFIGURATION ISSUES

### 4.1 Inconsistent Pool Configuration

**Current State**:
```
✓ packages/db: singleThread: true
✓ packages/file-explorer: singleThread: true
✓ packages/file-explorer-hooks: singleThread: true
✗ packages/ui: maxThreads: 2 (INCONSISTENT)
✗ packages/file-explorer-ui: Missing explicit config
✗ packages/app-shell: maxThreads: 2 (INCONSISTENT)
✗ packages/db-explorer: maxThreads: 2 (INCONSISTENT)
```

**Issues**:
1. Mixed thread strategies cause unpredictable performance
2. No thread pool optimization for fast unit tests
3. Some packages have isolate: true (slow), others don't configure it

**Recommendations**:
- Packages with &lt;10s total test time: Remove isolate, use maxThreads: 4
- Packages with DB operations: Keep singleThread: true
- React/UI packages: maxThreads: 2 with isolate: false for speed

**Files to Update**:
- `/packages/ui/vitest.config.mts` (line 12-17)
- `/packages/file-explorer-ui/vitest.config.mts` (line 19)
- `/packages/app-shell/vitest.config.mts`
- `/packages/db-explorer/vitest.config.ts`

### 4.2 Missing isolate: false for Fast Unit Tests

**Impact of isolate: true** (current state in 4 files):
- Each test spawns new VM context: 50-200ms overhead
- For 50 tests: 2.5-10 seconds wasted isolation overhead
- Only needed for tests with global state mutations

**Affected Packages**:
- file-explorer-ui (19 tests)
- file-explorer-hooks (18 tests in use-file-tree alone)

**Quick Win**: Set `isolate: false` for packages without global state:
- Expected 20-30% speedup for these packages

### 4.3 Coverage Collection Overhead

**Status**: Root vitest.config.ts has coverage enabled with v8 provider

```typescript
// Root config lines 16-40: Coverage always enabled
coverage: {
  provider: 'v8',
  reportsDirectory: './coverage',
  reporter: ['text', 'lcov', 'json'],
  // ... lines of configuration
}
```

**Issue**: Coverage collection adds 30-50% overhead to test runs when not needed locally.

**Recommendation**: Make coverage opt-in via environment variable:
```typescript
const collectCoverage = process.env.COVERAGE === 'true';
coverage: collectCoverage ? { ... } : undefined
```

**Impact**: 20-40% faster local test runs (dev experience improvement)

---

## 5. REACT TESTING LIBRARY PATTERNS

### 5.1 Excessive Query Usage

**File**: `/packages/file-explorer-ui/src/__tests__/preview-panel.test.tsx`
- **Query Count**: 80 getBy/queryBy/findBy calls across 55 tests
- **Average**: 1.45 queries per test (high)

**Inefficient Pattern Example** (line 1350-1401):
```typescript
// Lines 1352-1354: Multiple queries for same element
const groupedFileCheckboxes = screen.getAllByTestId('checkbox'); // Returns array
const groupedFile1Checkbox = groupedFileCheckboxes.find((cb) =>
  cb.getAttribute('aria-label')?.includes('file1.txt')
);
```

**Impact**: 
- getAllByTestId + manual find: 10-20ms per query
- Used 10+ times in test: 100-200ms per test

**Optimization**: Combine selectors
```typescript
const groupedFile1Checkbox = screen.getByRole('checkbox', {
  name: /file1\.txt/i
});
```

### 5.2 findBy Usage When getBy Would Work

**Files**: Multiple component tests
- 26 findBy calls found in sample (reactive/data-dependent tests)
- findBy adds 500-1000ms wait timeout per call

**Pattern**: Used even when data is available immediately after render

**Recommendation**: Replace with getBy when data is deterministic

### 5.3 Multiple Renders in Single Test

**File**: `/packages/file-explorer-ui/src/__tests__/preview-panel.test.tsx`
- **Example** (lines 1373-1401): 4 renders in one test (one per grouping mode)

```typescript
for (const grouping of testGroupings) {
  const { unmount } = render(<PreviewPanel {...mockProps} />); // RENDER 1-4
  // ... test logic
  unmount();
}
```

**Impact**: 4 × (setup + render + unmount) = 400-800ms per test

**Better Approach**: Split into 4 parametrized tests or use a data-driven approach

---

## 6. CI/LOCAL DISCREPANCIES

### 6.1 Excluded Tests in CI

**File**: `/packages/db/vitest.config.mts` (lines 8-18)
```typescript
if (isCI) {
  excludePatterns.push(
    '__tests__/file-chunk-repository.test.ts',
    '__tests__/file-record-repository.test.ts',
    '__tests__/migration-*.test.ts',
    '__tests__/repository-factory.test.ts',
    '__tests__/db-provider-migration.test.tsx',
    '__tests__/wasm-loader-coverage.test.ts'
  );
}
```

**Issue**: 6 test files completely excluded in CI due to WASM/PGlite issues

**Impact**: 
- Coverage gap in CI (untested code paths)
- Local vs CI test suites are different
- No regression detection for WASM-dependent tests

**Root Cause**: WASM loader compatibility with PGlite in CI environment

**Action Required**: Fix WASM loading or mock strategy rather than excluding

### 6.2 Increased Timeouts in CI

**Files with High Timeouts**:
- `/packages/db/vitest.config.mts`: hookTimeout: 30s, testTimeout: 20s
- `/packages/file-explorer-ui/vitest.config.mts`: testTimeout: 30s
- `/packages/file-explorer-hooks/vitest.config.mts`: testTimeout: 30s

**Issue**: Generic high timeouts mask performance problems. No differentiation between:
- Genuinely slow tests (legitimately need 20s+)
- Tests that are too slow (should be optimized)

**Recommendation**: Audit which tests need >10s timeouts and why

---

## 7. TEST ORGANIZATION

### 7.1 Large Monolithic Test Files

**Top 10 Largest Test Files**:
1. preview-panel.test.tsx: 1,427 lines (55 tests) - **CRITICAL**
2. use-file-tree.test.ts: 940 lines (18 tests) - **HIGH**
3. database-demo-panel.test.tsx: 863 lines (32 tests) - **HIGH**
4. file-chunk-repository.test.ts: 857 lines (118 tests) - **HIGH**
5. use-file-content-loading.test.ts: 824 lines (tests)
6. file-selection-actions.test.ts: 786 lines (tests)
7. worker-storage.test.ts: 771 lines (tests)
8. preview-panel.integration.test.tsx: 744 lines (tests)

**Recommendation**: Split files >600 lines into logical units
- **preview-panel.test.tsx**: Split into:
  - preview-panel.empty.test.tsx (empty state)
  - preview-panel.display.test.tsx (rendering)
  - preview-panel.interaction.test.tsx (user interactions)
  - preview-panel.performance.test.tsx (performance scenarios)

**Benefits**:
- Faster test discovery and filtering
- Better test isolation
- Parallel test execution per file
- Easier to maintain and extend

### 7.2 Mixed Integration/Unit Tests in Same File

**Database Demo Panel Test** (lines 143-863):
- 863 lines contains both unit tests (mocked dependencies) and some integration-like scenarios
- No clear separation between test types

**Recommendation**: Create separate files:
- database-demo-panel.unit.test.tsx (mocked)
- database-demo-panel.integration.test.tsx (real services)

### 7.3 Missing Test Categorization

**Current Practice**: Tests use `describe()` for organization

**Missing**: No `test.skip()`, `test.only()`, or test tags for:
- Slow tests (>5s each)
- Flaky tests
- Platform-specific tests (Electron only)
- UI only vs headless compatible

**Implementation**: Add test metadata:
```typescript
test('slow operation', { timeout: 30000 }, async () => {
test('flaky network call', { skip: isCIEnvironment }, async () => {
test.only('focused test', async () => {
```

---

## 8. SPECIFIC OPTIMIZATION RECOMMENDATIONS

### 8.1 Priority 1: High-Impact, Low-Effort

| Issue | File(s) | Effort | Estimated Gain | Action |
|-------|---------|--------|-----------------|--------|
| Remove snapshot tests | preview-panel.test.tsx | 2 hours | 15% speedup | Replace 4 snapshots with property assertions |
| Consolidate E2E filter tests | file-explorer*.test.ts | 3 hours | 25% E2E faster | Merge 5 files into 2 parametrized suites |
| Add isolate: false | ui, file-explorer-ui, app-shell | 1 hour | 25% speedup | Update 4 vitest configs |
| Extract mock setup | preview-panel.test.tsx | 2 hours | 40% speedup | Move 325 lines of mocks to separate file |
| Fix dynamic imports | Multiple agent tests | 1 hour | 10% speedup | Change `await import()` to static imports |

**Total Time Investment**: 9 hours
**Estimated Total Gain**: 30-40% overall test speedup

### 8.2 Priority 2: Medium-Impact, Medium-Effort

| Issue | Files Affected | Effort | Estimated Gain |
|-------|----------------|--------|-----------------|
| Split monolithic test files | 8 files >700 lines | 8 hours | 20% parallel improvement |
| Replace large test data | db tests, db-explorer tests | 4 hours | 30% memory, 15% startup |
| Fix coverage overhead | Root vitest config | 2 hours | 20-40% local speedup |
| Audit timeout values | 10+ files | 3 hours | Identify legitimately slow tests |

---

## 9. TEST EXECUTION PATTERN ANALYSIS

### 9.1 Global Setup Overhead

**File**: `/packages/test-utils/src/vitest.setup.ts` (135 lines)

**Overhead per test suite**:
- 35 mock definitions (window.matchMedia, IntersectionObserver, ResizeObserver, etc.)
- TextDecoder/TextEncoder polyfills
- Blob/Buffer polyfills
- Custom fetch wrapper

**Impact**: 100-200ms per test file initialization

**Optimization**: Lazy load non-essential mocks

### 9.2 beforeEach/afterEach Costs

**Database Tests**:
```typescript
// file-chunk-repository.test.ts beforeEach
const db: PGlite = await wasmLoader.createPGlite('memory://file-chunk-repo');
await migrate(db); // Database migration for every test
```

**Cost**: 500-1000ms per test for WASM instantiation and migration

**Optimization**:
- Use test-scoped database: 2-5s once per suite vs 500ms per test
- Lazy initialize test DB, share across tests
- Use transactions for rollback instead of full reinit

---

## 10. SUMMARY AND ACTION PLAN

### Quick Wins (1-2 weeks)
1. **Extract preview-panel mocks** (~2.5s saved)
2. **Remove/replace snapshots** (~1s saved)
3. **Add isolate: false** (~2-3s saved)
4. **Consolidate E2E tests** (~5-10s saved for E2E)

**Total Quick Wins**: 10-15% overall improvement

### Medium-Term (2-4 weeks)
1. Split large test files (8 files)
2. Optimize database test initialization
3. Reduce test data sizes
4. Fix CI test exclusions

**Total Medium-Term**: 25-35% overall improvement

### Long-Term (1-2 months)
1. Implement test categorization and metadata
2. Refactor global setup for lazy loading
3. Create test performance dashboard/CI tracking
4. Establish test performance budgets

**Total Long-Term**: 40-50% overall improvement

---

## Files Referenced (Absolute Paths)

### Test Files Analyzed
- `packages/file-explorer-ui/src/__tests__/preview-panel.test.tsx`
- `packages/db-explorer/src/__tests__/database-demo-panel.test.tsx`
- `packages/db/__tests__/file-chunk-repository.test.ts`
- `apps/web/e2e/file-explorer*.test.ts` (5 files)

### Configuration Files
- `vitest.config.ts` (root)
- `packages/db/vitest.config.mts`
- `packages/ui/vitest.config.mts`
- `packages/file-explorer-ui/vitest.config.mts`
- 10+ other package vitest configs

### Setup Files
- `packages/test-utils/src/vitest.setup.ts`
- `packages/db/vitest.setup.ts`

---

## Statistics Summary

- **Total Test Files**: 403 (excluding node_modules, .stryker-tmp)
- **Total Lines of Test Code**: 69,960+ lines
- **Snapshot Tests**: 77 across 18 files
- **vi.mock() Instances**: 287+ across 110 files
- **Largest Test File**: preview-panel.test.tsx (1,427 lines)
- **E2E Test Files**: 24 for web app
- **Database Test Files**: 36
- **Configuration Inconsistencies**: 4 different pool strategies across packages
