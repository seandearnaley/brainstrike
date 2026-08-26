#!/bin/zsh
set -euo pipefail

WORKTREE="/Users/seandearnaley/Documents/GitHub/brainstrike/.claude/worktrees/agent-a74453e1f5212317d"
LOG="$WORKTREE/.claude-scratch/codex-task2.log"
DONE_MARKER="$WORKTREE/.claude-scratch/codex-task2.done"

rm -f "$DONE_MARKER"

PROMPT="You are implementing Task 2 of BST-1392 (W5, Layer 1) in the brainstrike monorepo, working directory $WORKTREE, on branch seandearnaley/bst-1392-w5-map-contracts. Task 1 is already committed on this branch (WorktreeListEntry.createdAt/primary/repoCommonDir, PRIMARY_CHECKOUT_GATE) — do not re-touch its files except where Task 2's own brief explicitly says to modify worktree-service.ts or use-worktree-mode.ts further.

Read TWO documents before writing any code, in this order:
1. $WORKTREE/.claude-scratch/task-2-brief.md — the full brief for Task 2 (creates worktree-adopt.ts, wires worktrees:adopt through the IPC bridge, replaces the picker's placeholder adoption toast). Follow its numbered Steps 1-10 in order, RED first (Step 1-2: write the failing test, confirm it fails), then GREEN (Steps 3-9), matching every field name, error message string, and code shape VERBATIM except where corrections.md below overrides it.
2. $WORKTREE/.claude-scratch/task2-corrections.md — four pre-verified corrections to apply on top of the brief (I independently checked these against this exact checkout, they are not guesses): (1) drop the unused WorktreeCheckoutStatus import from worktree-adopt.ts's Step 4 code — that type does not exist yet anywhere in this repo and Task 2 does not add it; (2) use generateWorkspaceSnapshotId() from ./snapshot-repository instead of importing uuidv7 from the uuidv7 npm package, which is not a dependency here; (3) add a primary-checkout guard to adoptWorktree itself (exact code given in the corrections file) plus one new test case in worktree-adopt.test.ts, because nothing in the brief's own adoptWorktree implementation stops it from adopting the repository's own primary checkout, and that same function will be reachable directly by an agent tool, bypassing the picker's UI-level disabling; (4) corrected test-run commands since neither package defines a bare 'vitest' script.

Follow RED/GREEN TDD per the brief's own Step 1/Step 2 structure. Use exact verbatim code/messages from the brief except for the four corrections — do not paraphrase, do not invent additional behavior beyond what the brief and corrections specify. Step 10 in the brief says to commit — IMPORTANT: do NOT commit and do NOT push. Stop after Step 9's tests are green and leave the working tree with changes present (staged or unstaged); the calling process runs additional gates (including static-analysis lanes not in the brief) and commits separately, folding in some other small fixes already made on this branch.

If, while implementing, you find the brief references any OTHER existing symbol, file, or test helper that turns out not to exist at this HEAD (beyond the four corrections already given to you) — the same class of problem a prior Task 1 attempt hit when a brief assumed a mocked test file that had never existed in this repo's history — STOP, do not invent scaffolding to paper over it, and report exactly what is missing and where you verified it (grep output, file listing) instead of guessing at a plausible shape. This is a hard rule, not a suggestion.

Report clearly at the end: files touched, full test run output summary (pass/fail counts for worktree-adopt.test.ts — expect 6 passed, not the brief's stated 5, because of correction #3 — preload-runtime-contract.test.ts, use-worktree-mode.test.ts, and worktrees-bridge.test.ts), and any deviation beyond the four corrections with justification."

echo "=== codex exec task2 starting at $(date) ===" > "$LOG"
(
  codex exec --cd "$WORKTREE" -s workspace-write "$PROMPT" >> "$LOG" 2>&1
  echo "EXIT_CODE:$?" >> "$LOG"
  touch "$DONE_MARKER"
) &
CODEX_PID=$!
echo "$CODEX_PID" > "$WORKTREE/.claude-scratch/codex-task2.pid"
disown

echo "codex exec task2 launched with pid $CODEX_PID, logging to $LOG"

while [ ! -f "$DONE_MARKER" ]; do
  sleep 5
done

echo "=== codex exec task2 finished at $(date) ==="
echo "--- log tail ---"
tail -n 300 "$LOG"
