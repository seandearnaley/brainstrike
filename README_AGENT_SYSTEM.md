# LLM Agent System for TypeScript Test Configuration Fix
**Created**: October 17, 2025
**Status**: Ready for Agent Assignment

---

## What This Is

A complete, resumable system for an LLM coding agent to systematically fix TypeScript test configuration across 15 packages in the brainstrike monorepo.

**Why This Matters**: Currently ~350+ test files are NOT being type-checked by the CI. This system enables that without breaking anything.

---

## Files in This System

### 1. **AGENT_PROMPT_TS_TEST_CONFIG_FIX.md** (333 lines)
**The Master Prompt** - Give this to your LLM agent as the primary instructions.

Contains:
- Complete mission briefing
- Step-by-step process for each package
- Phase-by-phase breakdown
- Decision trees for common scenarios
- Resumption protocol for continuity
- Quality checklist
- Success criteria

**How to Use**: Copy entire content and give to agent as system instruction.

---

### 2. **TS_TEST_CONFIG_FIX_CHECKLIST.md** (222 lines)
**The Tracking Document** - Agent updates this as they work.

Contains:
- All 15 packages organized by phase and priority
- Checkbox tasks for each package
- Estimated time per package
- Status indicators (PENDING/IN_PROGRESS/COMPLETE)
- Session logging area
- Statistics dashboard

**How to Use**: Agent marks tasks complete here. Humans can check progress by viewing this file.

---

### 3. **ERRORS_FOUND.md** (83 lines)
**The Error Log** - Agent documents ALL TypeScript errors discovered.

Contains:
- Template for documenting errors
- Pre-filled example (embeddings - already fixed)
- Error categories and severity levels
- Statistics tracker

**How to Use**: Agent adds findings here. Future maintenance uses this to understand error patterns.

---

### 4. **TS_TEST_CONFIG_REPORT_2025-10-17.md** (153 lines)
**Reference Information** - Already created, shows the analysis.

This is your background report showing:
- Current state of all packages
- Which have tests excluded
- Which have tsconfig.test.json but don't use it
- Risk assessment by priority
- Recommendations

**How to Use**: Agent reads for context. You keep for records.

---

## How to Use This System

### Step 1: Assign to Agent
```
Give agent this prompt: ⬇️

Read these files IN ORDER:
1. README_AGENT_SYSTEM.md (this file)
2. TS_TEST_CONFIG_REPORT_2025-10-17.md (context)
3. AGENT_PROMPT_TS_TEST_CONFIG_FIX.md (your instructions)

Then open TS_TEST_CONFIG_FIX_CHECKLIST.md and begin with PHASE 1.
Update CHECKLIST and ERRORS_FOUND.md as you complete each package.
```

### Step 2: Monitor Progress
Watch these files change:
- **TS_TEST_CONFIG_FIX_CHECKLIST.md**: See ✅ COMPLETE marks appearing
- **ERRORS_FOUND.md**: See error documentation being added
- **Git log**: See commits being made per package

### Step 3: If Interrupted
Simply give agent this command:
```
Check TS_TEST_CONFIG_FIX_CHECKLIST.md for [LAST_COMPLETED].
Continue from the next PENDING item.
Update the session info and proceed.
```

Agent can resume immediately - all operations are idempotent.

---

## Key Design Principles

✅ **Idempotent**: Every step can be safely re-run without side effects
✅ **Resumable**: Can pick up mid-task from another LLM if needed
✅ **Trackable**: Clear audit trail in checklist and git commits
✅ **Documented**: Every error discovery is recorded
✅ **Safe**: No risky operations, all changes are additive
✅ **Verifiable**: Can check progress by looking at files

---

## Expected Timeline

| Phase | Packages | Est. Time | Status |
|-------|----------|-----------|--------|
| 1 | 4 | 15 min | Quick wins |
| 2 | 4 | 50 min | High priority |
| 3 | 4 | 40 min | Medium priority |
| 4 | 3+ | 50 min | Low priority |
| **Total** | **15** | **~3 hours** | Ready to start |

---

## Files Agent Must Update

1. **TS_TEST_CONFIG_FIX_CHECKLIST.md**
   - [ ] Add SESSION_ID at top
   - [ ] Mark tasks ✅ COMPLETE as done
   - [ ] Update Session Log

2. **ERRORS_FOUND.md**
   - [ ] Add package results after each type-check
   - [ ] Update statistics
   - [ ] Document any blockers

3. **Git**
   - [ ] Commit after each package (atomic commits)
   - [ ] Use message format: `feat: enable test file type-checking for @brainstrike/[pkg]`

---

## Success Criteria

Agent is done when:
- ✅ All 15 packages in CHECKLIST marked COMPLETE
- ✅ `pnpm run type-check` from repo root succeeds (all 15 packages pass)
- ✅ ERRORS_FOUND.md fully populated with findings
- ✅ 15 atomic git commits made (one per package)
- ✅ No regressions (no previously working code broken)

---

## What Agent Needs

**Read**: 
- This file
- TS_TEST_CONFIG_REPORT_2025-10-17.md
- AGENT_PROMPT_TS_TEST_CONFIG_FIX.md

**Update**:
- TS_TEST_CONFIG_FIX_CHECKLIST.md (progress tracking)
- ERRORS_FOUND.md (error documentation)

**Execute**:
- Create tsconfig.test.json files
- Update package.json scripts
- Run pnpm type-check commands
- Make git commits

**Avoid**:
- Modifying source code
- Fixing test code (just enable checking)
- Changing other configuration
- Skipping documentation

---

## For Context: What Was Already Done

✅ **packages/embeddings**: Already fixed (51 errors found and resolved)
- tsconfig.test.json created
- Mock implementations fixed
- Type signatures corrected
- All test files now type-checked
- Ready as reference example

---

## Quick Start Template

Give agent this:

```
YOUR MISSION:
Fix TypeScript test configuration for 15 packages.

YOUR RESOURCES:
1. AGENT_PROMPT_TS_TEST_CONFIG_FIX.md - Read this first
2. TS_TEST_CONFIG_FIX_CHECKLIST.md - Update this as you go
3. ERRORS_FOUND.md - Document your findings here

YOUR STEPS:
1. Read the prompt file completely
2. Update CHECKLIST with your session ID
3. Start with PHASE 1 (Quick Wins) - packages/ui, packages/app-shell, etc.
4. For each package: Create config, update script, run type-check, commit
5. Mark tasks complete in CHECKLIST
6. Document errors in ERRORS_FOUND.md
7. When all 15 packages done: Run `pnpm run type-check` from root
8. Verify success and commit final status

You have 3-4 hours to complete all 15 packages.
All operations are resumable if you get interrupted.
```

---

## Questions?

**Q: What if the agent finds TypeScript errors?**
A: That's normal! Document them in ERRORS_FOUND.md. We're enabling type-checking, so errors will appear. The agent should document but not fix them (unless trivial).

**Q: What if a package has no test files?**
A: Skip it. The checklist only includes packages with actual test files.

**Q: What if agent gets interrupted?**
A: Check CHECKLIST for last completed package, continue from next PENDING item. Everything is designed to be resumable.

**Q: How do we verify it worked?**
A: Run `pnpm run type-check` from repo root. Should see "Tasks: 15 successful, 15 total" (or more if including other packages).

---

## Final Notes

This system was designed for **total continuity and safety**:
- Every operation is reversible (new files, script updates, commits)
- Every progress point is tracked (checklist + git)
- Every finding is documented (error log)
- Every package is independent (can do them in any order if needed)

**It's ready. Give it to your agent. They'll know what to do.** 🚀

