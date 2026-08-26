#!/bin/zsh
set -euo pipefail

WORKTREE="/Users/seandearnaley/Documents/GitHub/brainstrike/.claude/worktrees/agent-a74453e1f5212317d"
LOG="$WORKTREE/.claude-scratch/codex-task1-v2.log"
DONE_MARKER="$WORKTREE/.claude-scratch/codex-task1-v2.done"

rm -f "$DONE_MARKER"

PROMPT="You are implementing Task 1 of BST-1392 (W5, Layer 1) in the brainstrike monorepo, working directory $WORKTREE, on branch seandearnaley/bst-1392-w5-map-contracts. There are TWO documents you must read, in this order, before writing any code:

1. $WORKTREE/.claude-scratch/coordinator-ruling.md — a coordinator ruling that OVERRIDES part of the brief below. A prior attempt at this task correctly blocked because the brief's Step 1 assumed a mocked unit-test file (apps/desktop/src/__tests__/assistant-server/worktree-service.test.ts with describe(createWorktreeService), makeService(), worktreeDescriptor(), managedRow()) that does not exist anywhere in this repo's git history. The coordinator ruled: port Steps 1-2 into the REAL integration suite (apps/desktop/src/__tests__/assistant-server/worktree-service.integration.test.ts) using the existing real-git + real-PGlite fixture kit in worktree-service.shared.ts (createTestWorkspace, buildTestService, asLedgerDatabase, git). The EXACT test code for the corrected Steps 1-2 has ALREADY been written into the plan document at $WORKTREE/docs/superpowers/plans/2026-08-26-w5-worktree-map-and-agent-tools.md — find the section 'Task 1: WorktreeListEntry gains identity, age and the primary gate' in that file and copy its Step 1 test code (two it(...) blocks: 'marks the repository main worktree as the primary and refuses it as a checkout target' and 'carries the repository common dir and the ledger creation stamp onto every entry') VERBATIM into worktree-service.integration.test.ts, inside the existing describe('WorktreeService (real git + real PGlite)') block. Use its corrected Step 2 RED run command too: pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-service.integration.test.ts. Note the two new test cases need these imports already present at the top of worktree-service.integration.test.ts: GitInventory from @brainstrike/types, createWorktreeLedger from ../../assistant-server/worktree-ledger, asLedgerDatabase/git from ./worktree-service.shared, realpathSync from node:fs — check which are already imported and only add what's missing.

2. $WORKTREE/.claude-scratch/task-1-brief.md — the original brief. Its Steps 3-8 are UNCHANGED and still authoritative: extend WorktreeListEntry in packages/types/src/worktree.ts with createdAt/primary/repoCommonDir (alphabetically sorted), update inventoryListEntry/ghostListEntry/PRIMARY_CHECKOUT_GATE in apps/desktop/src/assistant-server/worktree-service.ts, add the picker-side test to packages/app-shell/src/__tests__/use-worktree-mode.test.ts (Step 5 — that file DOES exist, no change from the brief there) and update its entry(...) fixture factory with the three new default fields, run Step 6 tests (desktop integration lane per the corrected command above, plus the app-shell unit test), run Step 7 full type-check, run Step 8 ultracite fix/check exactly as specified.

Follow RED/GREEN TDD: write the two new integration test cases first (RED — confirm they fail against the current WorktreeListEntry shape), then make the brief's Steps 3-5 code changes (GREEN), then verify with Steps 6-7, then Step 8's ultracite commands. Use EXACT verbatim code/messages from the brief and the plan document's corrected Step 1 — do not paraphrase or invent alternate field names, error messages, or fixture mechanics beyond what's specified. IMPORTANT: do NOT commit — stop after ultracite fix/check pass and leave the working tree with changes present (staged or unstaged); the calling process runs additional gates and commits separately. If ultracite check flags noExcessiveLinesPerFile on worktree-service.ts, do NOT create worktree-adopt.ts yourself (that is Task 2's job) — stop and report the exact line count and violation instead. Report clearly at the end: files touched, full test run output summary (pass/fail counts for both the new integration tests and the app-shell test), and any deviation from the brief/ruling with justification."

echo "=== codex exec v2 starting at $(date) ===" > "$LOG"
(
  codex exec --cd "$WORKTREE" -s workspace-write "$PROMPT" >> "$LOG" 2>&1
  echo "EXIT_CODE:$?" >> "$LOG"
  touch "$DONE_MARKER"
) &
CODEX_PID=$!
echo "$CODEX_PID" > "$WORKTREE/.claude-scratch/codex-task1-v2.pid"
disown

echo "codex exec v2 launched with pid $CODEX_PID, logging to $LOG"

while [ ! -f "$DONE_MARKER" ]; do
  sleep 5
done

echo "=== codex exec v2 finished at $(date) ==="
echo "--- log tail ---"
tail -n 300 "$LOG"
