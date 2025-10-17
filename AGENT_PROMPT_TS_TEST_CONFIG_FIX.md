# Master Prompt: TypeScript Test Configuration Fix for Brainstrike Monorepo
**Version**: 1.0
**Date**: October 17, 2025

---

## YOUR MISSION

You are a TypeScript/TypeScript configuration specialist. Your mission is to systematically fix TypeScript test configuration across 15 packages in the brainstrike monorepo. Your work is idempotent, resumable, and can be picked up by another LLM if interrupted.

**Goal**: Enable test file type-checking on ALL packages so CI catches TypeScript errors in test code.

**Scope**: 15 packages, ~350+ test files, 4 phases

**Success Criteria**:
- ✅ All 15 packages have `tsconfig.test.json` (if needed)
- ✅ All package.json type-check scripts include test config
- ✅ `pnpm run type-check` from root succeeds with zero errors
- ✅ All changes committed to git
- ✅ Checklists and error tracking updated

---

## TRACKING & CONTINUITY

### Critical Files You Must Update
1. **TS_TEST_CONFIG_FIX_CHECKLIST.md** - Mark tasks COMPLETE/IN PROGRESS as you go
2. **ERRORS_FOUND.md** - Document all TypeScript errors discovered
3. **Git commits** - Commit after each package or phase completion

### If You Get Interrupted
1. Check: **TS_TEST_CONFIG_FIX_CHECKLIST.md** - Find the last COMPLETE package
2. Continue from: The next PENDING item in that file
3. **ALL operations are idempotent** - You can safely re-run any step

### Session Protocol
**BEFORE YOU START**: Add to CHECKLIST:
```
[AGENT_SESSION_ID]: [Your identifier or timestamp]
[START_TIME]: [Current time]
```

**AFTER EACH PACKAGE**: Update CHECKLIST:
```
- [x] packages/[NAME] COMPLETE - No errors / X errors found (see ERRORS_FOUND.md)
```

**IF INTERRUPTED**: Update CHECKLIST:
```
[LAST_COMPLETED]: [PACKAGE_NAME]
[LAST_PHASE]: [1-4]
[CURRENT_STATUS]: [Description of what was interrupted]
```

---

## THE PROCESS

### For Each Package (Standard Template)

1. **Verify Current State**
   ```bash
   # Check if tests are excluded
   grep '"\*\*\/\*\.test\.' [PACKAGE_PATH]/tsconfig.json
   
   # Check if tsconfig.test.json exists
   ls -la [PACKAGE_PATH]/tsconfig.test.json
   
   # Check current type-check script
   grep 'type-check' [PACKAGE_PATH]/package.json
   ```

2. **Create tsconfig.test.json** (if doesn't exist)
   ```json
   {
     "extends": "./tsconfig.json",
     "compilerOptions": {
       "types": ["vitest", "node"],
       "skipLibCheck": true
     },
     "include": ["src/**/*", "**/*.test.*"],
     "exclude": ["dist", "node_modules"]
   }
   ```

3. **Update package.json type-check script**
   ```json
   "type-check": "tsc --noEmit && tsc --noEmit --project tsconfig.test.json"
   ```

4. **Run Type-Check**
   ```bash
   pnpm --filter @brainstrike/[PACKAGE] run type-check
   ```

5. **Document Results**
   - Add to ERRORS_FOUND.md: `### [PACKAGE_NAME]`
   - List any errors found (with file:line references)
   - Mark severity: 🔴 CRITICAL / 🟡 MEDIUM / 🟢 LOW
   - Note patterns or recurring issues

6. **Commit Changes**
   ```bash
   git add packages/[PACKAGE]/tsconfig.test.json packages/[PACKAGE]/package.json
   git commit -m "feat: enable test file type-checking for @brainstrike/[package]"
   ```

---

## PHASE-BY-PHASE GUIDE

### PHASE 1: Quick Wins (4 packages, 15 min total)
**These have tsconfig.test.json already. Just update scripts.**

Packages: ui, app-shell, desktop, web

For each:
1. Update package.json type-check script only
2. Run `pnpm --filter @brainstrike/[PKG] run type-check`
3. Verify no errors
4. Commit
5. Update CHECKLIST with ✅ COMPLETE

**Expected Outcome**: 4 packages done, 0 new errors

---

### PHASE 2: High Priority (4 packages, 50 min total)
**26-50 test files each. Create configs + update scripts.**

Packages: utils (CRITICAL), hooks, db-explorer, file-explorer-ui

For each:
1. Create tsconfig.test.json
2. Update package.json script
3. Run type-check
4. **IMPORTANT**: Document ALL errors in ERRORS_FOUND.md
5. Commit
6. Update CHECKLIST with completion status

**Expected Outcome**: 4 packages done, X errors documented

---

### PHASE 3: Medium Priority (4 packages, 40 min total)
**7-20 test files each.**

Packages: file-explorer-hooks, file-import, storage, vector-management

Same process as Phase 2:
1. Create tsconfig.test.json
2. Update package.json
3. Run type-check
4. Document errors
5. Commit

---

### PHASE 4: Low Priority (3+ packages, 50 min total)
**1-7 test files each.**

Packages: preferences, file-system, build-utils, platform-utils, fonts, types, config, server-config

Batch them in groups of 2-3 for efficiency:
1. Do 2-3 packages per batch
2. Document errors after each
3. Commit per batch

---

## KEY RULES

### ✅ DO THIS
- ✅ Mark completed tasks in CHECKLIST immediately after finishing
- ✅ Document errors with file:line references
- ✅ Commit after each package or batch
- ✅ Use same tsconfig.test.json template for all packages
- ✅ Run full monorepo check: `pnpm run type-check` to verify no regressions
- ✅ Be thorough with error documentation - future agents need this info

### ❌ DON'T DO THIS
- ❌ Don't skip error documentation - document what you find
- ❌ Don't commit without testing
- ❌ Don't modify tsconfig files beyond adding test config
- ❌ Don't change package.json except the type-check script
- ❌ Don't skip any package in your assigned phase

---

## DECISION TREE

**Q: Package already has tsconfig.test.json?**
- YES → Just update package.json type-check script
- NO → Create tsconfig.test.json first, then update script

**Q: Type-check reveals errors?**
- YES → Document in ERRORS_FOUND.md, still commit the config change
- NO → Great! Just mark complete and move to next package

**Q: Test files NOT excluded from tsconfig?**
- YES → Tests already being checked! Still verify type-check works, document this
- NO → This is what we're fixing - proceed normally

**Q: Get git conflicts?**
- Check which files are conflicting
- Resolve manually (shouldn't happen on new files)
- Update CHECKLIST about conflict
- Continue with next package

---

## QUALITY CHECKLIST FOR EACH PACKAGE

Before marking COMPLETE:
- [ ] tsconfig.test.json created/verified (or not needed)
- [ ] package.json type-check script updated
- [ ] `pnpm --filter @brainstrike/[PKG] run type-check` runs successfully
- [ ] Output verified (errors documented OR "no errors" noted)
- [ ] Changes committed to git
- [ ] CHECKLIST marked COMPLETE
- [ ] ERRORS_FOUND.md updated with findings

---

## ERROR DOCUMENTATION TEMPLATE

When documenting errors in ERRORS_FOUND.md:

```
### packages/[NAME]
- **Status**: COMPLETE / IN PROGRESS
- **Test Files**: [COUNT]
- **Errors Found**: [NUMBER]
  - Type: [Category] | File: [FILE.ts:LINE] | Message: [Short description]
  - Type: [Category] | File: [FILE.ts:LINE] | Message: [Short description]
- **Severity**: 🔴 CRITICAL / 🟡 MEDIUM / 🟢 LOW
- **Pattern**: [Any recurring pattern? e.g., "All mock classes missing method X"]
- **Blocker**: [Any blocker for this package?]
- **Notes**: [Anything else relevant]
```

---

## HOW TO RESUME (If Interrupted)

1. Open **TS_TEST_CONFIG_FIX_CHECKLIST.md**
2. Find the last task marked with ✅ COMPLETE
3. Continue from next PENDING item
4. Update SESSION_ID field with your session info
5. Add note about resuming
6. Continue normally

**Example Checklist Update**:
```
## Session Log
SESSION_ID: claude-4.5-haiku-2025-10-17-session-2
START_TIME: 2025-10-17 14:30 UTC
CURRENT_PHASE: 2
LAST_COMPLETED: packages/ui
INTERRUPTION_NOTE: Phase 1 complete, beginning Phase 2
ERRORS_FOUND: See ERRORS_FOUND.md
```

---

## FINAL VALIDATION

After completing ALL phases:

```bash
# 1. Run full monorepo type-check
pnpm run type-check

# 2. Verify all 15 packages pass
# Expected: "Tasks: 15 successful, 15 total"

# 3. Verify no new errors introduced
# Expected: 0 errors in output

# 4. Update CHECKLIST with final status
# Add: COMPLETION_TIME, TOTAL_ERRORS_FOUND, etc.
```

---

## SUCCESS MESSAGE

When everything is done:
- [ ] All 15 packages have test configs
- [ ] All type-check scripts updated
- [ ] Full monorepo type-check passes
- [ ] All errors documented
- [ ] All commits made
- [ ] Checklists fully updated
- [ ] README or notes for next steps

**Final Commit Message**:
```
feat: complete TypeScript test configuration across all packages

- Enabled test file type-checking for 15 packages
- Created/updated tsconfig.test.json and type-check scripts
- Documented [X] TypeScript errors found
- All errors categorized and tracked in ERRORS_FOUND.md
- CI will now catch test file TypeScript errors
```

---

## Questions to Ask Yourself

Before moving to the next package:
- ✅ Have I updated the CHECKLIST?
- ✅ Have I documented errors (or lack thereof)?
- ✅ Have I committed my changes?
- ✅ Did type-check run successfully?
- ✅ Am I following the template for each package?

If NO to any: Fix before continuing.

---

## You've Got This! 🚀

You have everything you need:
1. **Checklist** - Know what to do and track progress
2. **Error tracking** - Document what you find
3. **Template** - Same process for every package
4. **Resumability** - Can pick up where you left off
5. **Git** - Atomic commits for each package

**Start with PHASE 1 (Quick Wins) to build momentum!**

