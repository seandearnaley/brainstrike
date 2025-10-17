# TypeScript Test Configuration Fix Checklist
**Status**: In Progress
**Last Updated**: 2025-10-17
**Agent Session**: [TO BE FILLED BY AGENT]

---

## Overview
This document tracks the systematic fix of TypeScript test configuration across all packages in the brainstrike monorepo. Each package needs:
1. A `tsconfig.test.json` file (if not exists)
2. Updated `type-check` script in `package.json`
3. Any test-specific configuration adjustments

**Total Packages to Fix**: 15
**Total Test Files Affected**: ~350+

---

## PHASE 1: Quick Wins - Update Existing tsconfig.test.json Usage (4 packages)
These packages ALREADY have `tsconfig.test.json` files. Just need to update their type-check scripts.

### ✅ packages/ui (39 test files)
- [x] Has tsconfig.test.json: YES
- [ ] Update package.json type-check script
  - Current: `"tsc --noEmit"`
  - New: `"tsc --noEmit && tsc --noEmit --project tsconfig.test.json"`
- [ ] Verify: Run `pnpm --filter @brainstrike/ui run type-check`
- [ ] Verify: No TypeScript errors in output
- [ ] Verify: Commit changes

**Status**: PENDING
**Priority**: 🔴 HIGH (39 tests, UI critical)
**Estimated Time**: 5 minutes
**Dependencies**: None

---

### ✅ packages/app-shell (16 test files)
- [x] Has tsconfig.test.json: YES
- [ ] Update package.json type-check script
  - Current: `"tsc --noEmit"`
  - New: `"tsc --noEmit && tsc --noEmit --project tsconfig.test.json"`
- [ ] Verify: Run `pnpm --filter @brainstrike/app-shell run type-check`
- [ ] Verify: No TypeScript errors in output
- [ ] Verify: Commit changes

**Status**: PENDING
**Priority**: 🟡 MEDIUM (16 tests)
**Estimated Time**: 5 minutes
**Dependencies**: None

---

### ✅ apps/desktop (E2E tests separated)
- [x] Has tsconfig.test.json: YES
- [ ] Check current type-check structure: `pnpm type-check:main && pnpm type-check:e2e`
- [ ] Verify both scripts are being run
- [ ] If not using tsconfig.test.json in e2e, update script
- [ ] Verify: Run type-check
- [ ] Verify: No TypeScript errors in output
- [ ] Verify: Commit changes

**Status**: PENDING
**Priority**: 🟡 MEDIUM (E2E-specific)
**Estimated Time**: 10 minutes
**Dependencies**: None

---

### ✅ apps/web (Build + main check)
- [x] Has tsconfig.test.json: YES
- [ ] Current script: `"tsc --build --force && tsc --noEmit"`
- [ ] Check if test files are properly scoped
- [ ] If unit tests in main: Verify or update script
- [ ] Verify: Run type-check
- [ ] Verify: No TypeScript errors in output
- [ ] Verify: Commit changes

**Status**: PENDING
**Priority**: 🟡 MEDIUM (Web app)
**Estimated Time**: 10 minutes
**Dependencies**: None

---

## PHASE 2: Create Test Configs - High Priority (4 packages, 150+ tests)
These packages exclude tests but DON'T have test configs yet.

### ✅ packages/utils (26 test files - CRITICAL)
- [ ] Verify tests are excluded: `grep '"\*\*\/\*\.test\.' packages/utils/tsconfig.json`
- [ ] Create `packages/utils/tsconfig.test.json`
- [ ] Update package.json: `"tsc --noEmit && tsc --noEmit --project tsconfig.test.json"`
- [ ] Run: `pnpm --filter @brainstrike/utils run type-check`
- [ ] Document errors in ERRORS_FOUND.md
- [ ] Commit changes

**Status**: PENDING | **Priority**: 🔴 CRITICAL | **Time**: 20 min

---

### ✅ packages/hooks (8 test files)
- [ ] Create `packages/hooks/tsconfig.test.json`
- [ ] Update package.json type-check script
- [ ] Run type-check
- [ ] Document errors
- [ ] Commit

**Status**: PENDING | **Priority**: 🟡 MEDIUM | **Time**: 15 min

---

### ✅ packages/db-explorer (16 test files)
- [ ] Create `packages/db-explorer/tsconfig.test.json`
- [ ] Update package.json type-check script
- [ ] Run type-check
- [ ] Document errors
- [ ] Commit

**Status**: PENDING | **Priority**: 🟡 MEDIUM | **Time**: 15 min

---

### ✅ packages/file-explorer-ui (50 test files)
- [ ] Verify current state (excluded or checked?)
- [ ] Create/update tsconfig.test.json as needed
- [ ] Update package.json type-check script
- [ ] Run type-check
- [ ] Document errors
- [ ] Commit

**Status**: PENDING | **Priority**: 🔴 CRITICAL | **Time**: 20 min

---

## PHASE 3: Medium Priority (4 packages, ~50 tests)

### ✅ packages/file-explorer-hooks (20 test files)
- [ ] Create tsconfig.test.json
- [ ] Update type-check script
- [ ] Run type-check
- [ ] Document errors
- [ ] Commit

**Status**: PENDING | **Priority**: 🟡 MEDIUM | **Time**: 15 min

---

### ✅ packages/file-import (8 test files)
- [ ] Create tsconfig.test.json
- [ ] Update type-check script
- [ ] Run type-check
- [ ] Document errors
- [ ] Commit

**Status**: PENDING | **Priority**: 🟢 LOW | **Time**: 10 min

---

### ✅ packages/storage (8 test files)
- [ ] Create tsconfig.test.json
- [ ] Update type-check script
- [ ] Run type-check
- [ ] Document errors
- [ ] Commit

**Status**: PENDING | **Priority**: 🟢 LOW | **Time**: 10 min

---

### ✅ packages/vector-management (7 test files)
- [ ] Create tsconfig.test.json
- [ ] Update type-check script
- [ ] Run type-check
- [ ] Document errors
- [ ] Commit

**Status**: PENDING | **Priority**: 🟢 LOW | **Time**: 10 min

---

## PHASE 4: Low Priority (3+ packages, ~15 tests)

### ✅ packages/preferences, packages/file-system, packages/build-utils
- [ ] Create tsconfig.test.json for each
- [ ] Update type-check scripts
- [ ] Run type-check
- [ ] Document errors
- [ ] Commit

**Status**: PENDING | **Priority**: 🟢 LOW | **Time**: 30 min total

---

### ✅ packages/platform-utils, packages/fonts, packages/types, packages/config, packages/server-config
- [ ] Same process as above
- [ ] Create tsconfig.test.json
- [ ] Update scripts
- [ ] Verify
- [ ] Commit

**Status**: PENDING | **Priority**: 🟢 LOW | **Time**: 50 min total

---

## FINAL VERIFICATION
- [ ] Run `pnpm run type-check` from root
- [ ] Verify all 15 packages pass
- [ ] No new errors introduced
- [ ] Document completion time

**Status**: PENDING

---

## Session Log
```
SESSION_ID: [TO BE FILLED]
START_TIME: [TO BE FILLED]
CURRENT_PHASE: [1-4]
LAST_COMPLETED: [PACKAGE_NAME]
ERRORS_FOUND: See ERRORS_FOUND.md
```
