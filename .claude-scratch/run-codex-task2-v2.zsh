#!/bin/zsh
set -euo pipefail

WORKTREE="/Users/seandearnaley/Documents/GitHub/brainstrike/.claude/worktrees/agent-a74453e1f5212317d"
LOG="$WORKTREE/.claude-scratch/codex-task2-v2.log"
DONE_MARKER="$WORKTREE/.claude-scratch/codex-task2-v2.done"

rm -f "$DONE_MARKER"

PROMPT="You are resuming Task 2 of BST-1392 (W5, Layer 1) in the brainstrike monorepo, working directory $WORKTREE, on branch seandearnaley/bst-1392-w5-map-contracts. Task 1 is already committed. A prior codex attempt on Task 2 correctly stopped before writing any code (it made zero file changes) because the brief's Step 8 test snippet referenced mock names that do not exist in this file. That gap, and several other brief-vs-checkout gaps discovered since, are now fully resolved and documented for you — read all three of these files IN ORDER before writing any code:

1. $WORKTREE/.claude-scratch/task-2-brief.md — the original full brief. Follow it VERBATIM for everything the correction files below don't override.
2. $WORKTREE/.claude-scratch/task2-corrections.md — corrections #1-#3 (drop the unused WorktreeCheckoutStatus import from worktree-adopt.ts, use generateWorkspaceSnapshotId() instead of the uuidv7 npm package, add a primary-checkout guard to adoptWorktree plus one new test case) and correction #4 (corrected vitest run commands).
3. $WORKTREE/.claude-scratch/task2-corrections-v2.md — the full resolution for everything else: (a) use-worktree-mode.test.ts's Step 8 test additions are ALREADY DONE — do not touch that file at all, its mock setup already has adoptSpy/restoreSpy wired and its two new tests are already written and correctly RED; (b) a fully-verified plan for adding checkoutStatus plumbing ALONGSIDE adopt in this task (verified directly against Task 3's own section of the already-committed plan document, not guessed — the file names exact line numbers to check if you want to verify independently), covering packages/types/src/worktree.ts, desktop-ipc-channels.ts, worktrees-bridge.ts, electron.d.ts, preload.ts, and preload-runtime-contract.test.ts, including which files deliberately do NOT get a checkoutStatus addition yet (worktrees-ipc-handlers.ts, ipc-worktrees.ts, WorktreeService) because Task 3 owns those.

Implement everything needed to make all of these pass, using the exact vitest invocations from the corrections files (neither package has a bare 'vitest' script):
- apps/desktop: worktree-adopt.test.ts (expect 6 passed: the brief's 5 plus 1 new primary-refusal case) and preload-runtime-contract.test.ts (all passing, including the two parity tests that check hand-maintained literal lists against the actual preload.ts source)
- packages/app-shell: use-worktree-mode.test.ts (expect 30 passed: 28 pre-existing + 2 new adoption tests already in place) and src/worktrees/__tests__ (worktrees-bridge.test.ts)

RED/GREEN TDD per the brief's Step 1-2 structure for the NEW worktree-adopt.test.ts file (6 cases, RED then GREEN). The other suites (preload-runtime-contract, use-worktree-mode, worktrees-bridge) are pinning EXISTING-PLUS-NEW behavior across files you are modifying — get them green as you go, they don't need a separate formal RED phase since the RED state already exists (uncompiled/failing) from the test-file edits already in place.

IMPORTANT: do NOT commit and do NOT push. Stop once everything is green and leave the working tree with changes present; the calling process runs additional gates (static-analysis lanes, ultracite) and commits separately, folding in the already-applied use-worktree-mode.test.ts / worktree-service.integration.test.ts changes from earlier review rounds.

If you discover ANY further brief-references-something-that-does-not-exist situation not already covered by the three documents above, STOP immediately, do not invent scaffolding or guess a shape, and report exactly what is missing with the verification command/output you used (grep, rg, ls, etc.) — this is a hard rule established across this whole task chain, not a suggestion.

Report clearly at the end: files touched (full list), pass/fail counts for all four suites named above, and any deviation beyond what the three documents specify, with justification."

echo "=== codex exec task2 v2 starting at $(date) ===" > "$LOG"
(
  codex exec --cd "$WORKTREE" -s workspace-write "$PROMPT" >> "$LOG" 2>&1
  echo "EXIT_CODE:$?" >> "$LOG"
  touch "$DONE_MARKER"
) &
CODEX_PID=$!
echo "$CODEX_PID" > "$WORKTREE/.claude-scratch/codex-task2-v2.pid"
disown

echo "codex exec task2 v2 launched with pid $CODEX_PID, logging to $LOG"

while [ ! -f "$DONE_MARKER" ]; do
  sleep 5
done

echo "=== codex exec task2 v2 finished at $(date) ==="
echo "--- log tail ---"
tail -n 400 "$LOG"
