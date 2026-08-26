#!/bin/zsh
set -euo pipefail

WORKTREE="/Users/seandearnaley/Documents/GitHub/brainstrike/.claude/worktrees/agent-a74453e1f5212317d"
LOG="$WORKTREE/.claude-scratch/codex-task3.log"
DONE_MARKER="$WORKTREE/.claude-scratch/codex-task3.done"

rm -f "$DONE_MARKER"

PROMPT="You are implementing Task 3 of BST-1392 (W5, Layer 1) in the brainstrike monorepo, working directory $WORKTREE, on branch seandearnaley/bst-1392-w5-map-contracts. Tasks 1 and 2 are already committed, plus a fix commit removing a dead picker-adoption branch and a docs reconciliation commit. Read TWO documents before writing any code:

1. $WORKTREE/.claude-scratch/task-3-brief.md — the full brief for worktrees:checkoutStatus (lazy per-checkout dirty/ahead-behind status).
2. $WORKTREE/.claude-scratch/task3-corrections.md — a precise map of what Task 2 already shipped from this brief's own spec (verified byte-identical — six files, listed explicitly, do NOT touch them again) versus what's still genuinely needed, plus known gotchas already discovered and fixed once in the analogous Task 2 work (two bugs in this brief's own given test fixtures: a GitCommandRun mock missing timedOut/carrying a nonexistent signal field, and a run-call-count assertion that doesn't account for invokeGitHookFree's mandatory hook-config probe call).

Implement Step 3 (readCheckoutStatus in worktree-adopt.ts, restoring the parsePorcelainV2Z and WorktreeCheckoutStatus imports Task 2 deliberately dropped as unused-at-the-time, plus the service method, the IPC validator/handler/registration), Step 1's test additions to worktree-adopt.test.ts (adapted to this file's REAL existing makeDeps/inventory helpers, not the brief's inline ad-hoc deps object — read the file's actual current content first), and Step 5's new integration test file, applying the two known fixture-bug fixes described in the corrections document. Then update every test file the corrections document flags as needing a channel-count/mock-object bump for the new checkoutStatus handler registration (ipc-worktrees.test.ts's channel list, stub handlers, and per-handler falsifier assertions), verifying rather than assuming the ones Task 2 already touched (use-roots-reconciliation.test.tsx, use-workspace-bar.test.tsx, use-workspace-bar-write-tail.test.tsx, worktrees-bridge.test.ts) don't need further changes.

RED/GREEN TDD per the brief's own Step 1-2 structure for the new readCheckoutStatus tests. Use the corrected run commands in the corrections document (neither package has a bare 'vitest' script). Run the FULL desktop and app-shell unit lanes yourself before declaring done, not just the four suites the brief names — prior tasks in this chain found ripple effects in other test files that only the full lanes caught.

IMPORTANT: do NOT commit, do NOT push, do NOT run gh stack submit (Step 6 says to — ignore that part, the calling process handles commit and gates separately). Stop once everything is green and leave the working tree with changes present.

If you discover ANY brief-references-something-that-does-not-exist situation not already covered by the corrections document, STOP immediately, do not invent scaffolding or guess a shape, and report exactly what is missing with the verification command/output you used (grep, rg, ls, etc.) — this is a hard rule established across this whole task chain, not a suggestion.

Report clearly at the end: files touched (full list), which of the six already-done items you verified rather than re-implemented (one line each), pass/fail counts for every suite named in the corrections document, and any deviation with justification."

echo "=== codex exec task3 starting at $(date) ===" > "$LOG"
(
  codex exec --cd "$WORKTREE" -s workspace-write "$PROMPT" >> "$LOG" 2>&1
  echo "EXIT_CODE:$?" >> "$LOG"
  touch "$DONE_MARKER"
) &
CODEX_PID=$!
echo "$CODEX_PID" > "$WORKTREE/.claude-scratch/codex-task3.pid"
disown

echo "codex exec task3 launched with pid $CODEX_PID, logging to $LOG"

while [ ! -f "$DONE_MARKER" ]; do
  sleep 5
done

echo "=== codex exec task3 finished at $(date) ==="
echo "--- log tail ---"
tail -n 400 "$LOG"
