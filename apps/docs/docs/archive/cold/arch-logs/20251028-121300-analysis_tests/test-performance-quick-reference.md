---
title: "Test Performance Quick Reference"
status: "cold-archive"
date: "2025-10-28"
superseded_by: "none"
---

# Test Performance Optimization - Quick Reference Guide

## Critical Issues Found

### 1. HIGHEST PRIORITY - Monolithic Test Files

| File | Lines | Issue | Quick Fix Time | Impact |
|------|-------|-------|-----------------|--------|
| preview-panel.test.tsx | 1,427 | 325 lines of inline mocks | 2 hours | 40% speedup |
| database-demo-panel.test.tsx | 863 | 22 mock operations, 32 tests | 2 hours | 25% speedup |
| file-chunk-repository.test.ts | 857 | Vector data in memory | 1.5 hours | 20% speedup |
| use-file-tree.test.ts | 940 | Massive test file | 3 hours | 30% speedup |

### 2. Configuration Inconsistencies

**Problem**: Inconsistent vitest pool configurations
```
GOOD:    packages/db, file-explorer, file-explorer-hooks (singleThread: true)
BAD:     packages/ui, app-shell, db-explorer (maxThreads: 2)
MISSING: file-explorer-ui (isolate: true but no pool config)
```

**Quick Fix**: Add `isolate: false` to UI packages
**Time**: 30 minutes
**Gain**: 20-30% speedup for affected packages

### 3. E2E Test Redundancy

**5 file-explorer E2E tests** test nearly identical functionality:
- file-explorer.test.ts
- file-explorer-filters.test.ts
- file-explorer-settings.test.ts
- file-explorer-settings-advanced.test.ts
- file-explorer-settings-clamping.test.ts

**Solution**: Consolidate into 2 parametrized test suites
**Time**: 3 hours
**Gain**: 25-35% faster E2E runs

---

## Implementation Priorities

### Week 1: Quick Wins (9 hours total)
```
1. Extract preview-panel mocks to __mocks__/preview-panel-ui.ts (2 hrs)
2. Remove/replace snapshot tests with assertions (2 hrs)
3. Add isolate: false to ui, file-explorer-ui, app-shell (1 hr)
4. Fix dynamic imports in agent tests (1 hr)
5. Consolidate E2E filter tests (3 hrs)

EXPECTED GAIN: 30-40% overall test speedup
```

### Week 2-3: Medium Changes (12 hours total)
```
1. Split preview-panel.test.tsx into 4 files (3 hrs)
2. Optimize database test initialization (3 hrs)
3. Move large test data to fixtures (3 hrs)
4. Audit and remove >20s timeouts (2 hrs)
5. Fix CI test exclusions for DB (1 hr)

EXPECTED GAIN: Additional 15-20% improvement
```

---

## Code Snippets for Fixes

### Fix 1: Add isolate: false
```typescript
// packages/ui/vitest.config.mts
export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['@brainstrike/test-utils/vitest.setup'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 4, // Changed from 2
      },
    },
    isolate: false, // ADD THIS LINE
  },
});
```

### Fix 2: Extract Mocks
```typescript
// packages/file-explorer-ui/src/__tests__/__mocks__/ui-components.ts
export const createUIComponentMocks = () => ({
  Badge: ({ children, ...props }) => <div data-testid="badge" {...props}>{children}</div>,
  Button: ({ children, onClick, disabled, ...props }) => 
    <button onClick={onClick} disabled={disabled} {...props}>{children}</button>,
  // ... move all 15+ component mocks here
});

// In preview-panel.test.tsx (lines 45-370)
vi.mock('@brainstrike/ui', async () => {
  const { createUIComponentMocks } = await import('./__mocks__/ui-components');
  return createUIComponentMocks();
});
```

### Fix 3: Consolidate E2E Tests
```typescript
// apps/web/e2e/file-explorer-comprehensive.test.ts
const SETTINGS_SCENARIOS = [
  { name: 'basic', settings: {} },
  { name: 'advanced', settings: { useRegex: true } },
  { name: 'clamping', settings: { maxSelectionCount: 10 } },
];

test.describe('File Explorer - Settings', () => {
  SETTINGS_SCENARIOS.forEach(({ name, settings }) => {
    test(`should apply ${name} settings`, async ({ page }) => {
      // Single test covers all scenarios
    });
  });
});
```

---

## Metrics to Track

After implementing fixes, measure these metrics:

```bash
# Individual package times
pnpm test --filter @brainstrike/file-explorer-ui

# E2E duration
pnpm test:e2e

# Memory usage
node --max-old-space-size=4096 $(pnpm which vitest) run

# Coverage impact (if any)
pnpm test --coverage
```

---

## Critical Files to Address

### Immediate (This Week)
- `/packages/file-explorer-ui/src/__tests__/preview-panel.test.tsx` (1,427 lines)
- `/packages/db-explorer/src/__tests__/database-demo-panel.test.tsx` (863 lines)
- `/apps/web/e2e/file-explorer*.test.ts` (413 lines total, 5 files)
- `/packages/ui/vitest.config.mts` (add isolate: false)

### Near-Term (2-3 Weeks)
- `/packages/file-explorer-hooks/src/__tests__/use-file-tree.test.ts` (940 lines)
- `/packages/db/__tests__/file-chunk-repository.test.ts` (857 lines)
- `/packages/test-utils/src/vitest.setup.ts` (optimize global setup)

---

## Performance Baseline

Before starting optimizations, capture baseline:

```bash
# 1. Run tests once to warm up
pnpm test >/dev/null 2>&1

# 2. Measure test execution time
time pnpm test 2>&1 | grep -E "pass|fail|Test Files"

# 3. Measure memory
/usr/bin/time -v pnpm test 2>&1 | grep -E "Memory|CPU"

# 4. Save results
echo "BASELINE: $(date): $(pnpm test 2>&1 | tail -3)" >> /tmp/test-perf-baseline.txt
```

After implementing fixes:
```bash
# Compare
time pnpm test 2>&1 | tail -5
```

---

## Risk Mitigation

### Test Safety
- Run full test suite before and after each change
- Keep git branches for rollback
- Test in CI/CD first before committing

### Performance Regression Prevention
- Set test execution time budgets per package
- Alert if test time increases >5%
- Track metrics in CI/CD pipeline

---

## FAQ

**Q: Will consolidating E2E tests reduce coverage?**
A: No, parametrized tests cover the same scenarios more efficiently.

**Q: Is isolate: false safe?**
A: Yes, for UI packages with proper beforeEach cleanup. DB tests need singleThread for safety.

**Q: Should I split preview-panel.test.tsx into 4 files?**
A: Yes, enables parallel execution and faster iteration during development.

**Q: How much time will optimization take?**
A: Priority 1 (Quick Wins): 9 hours → 30-40% improvement
Priority 2 (Medium): 12 hours → +15-20% improvement

---

## Success Criteria

- [ ] Test execution time reduced by 30%+ (target: 8 minutes → 5.6 minutes)
- [ ] E2E tests run 25% faster
- [ ] All tests maintain 70%+ coverage threshold
- [ ] No performance regressions in subsequent test runs
- [ ] CI/CD pipeline completes 20% faster overall

