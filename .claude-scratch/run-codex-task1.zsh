#!/bin/zsh
set -euo pipefail

WORKTREE="/Users/seandearnaley/Documents/GitHub/brainstrike/.claude/worktrees/agent-a74453e1f5212317d"
LOG="$WORKTREE/.claude-scratch/codex-task1.log"
DONE_MARKER="$WORKTREE/.claude-scratch/codex-task1.done"

rm -f "$DONE_MARKER"

PROMPT="You are implementing Task 1 of BST-1392 (W5, Layer 1) in the brainstrike monorepo, working directory $WORKTREE. The COMPLETE requirements, with exact code to write, live in $WORKTREE/.claude-scratch/task-1-brief.md — open and read that file first, then follow its numbered steps VERBATIM (Steps 1-8): write the failing tests exactly as specified in worktree-service.test.ts and use-worktree-mode.test.ts, run them to confirm they fail (RED), extend packages/types/src/worktree.ts's WorktreeListEntry with the three new fields (createdAt, primary, repoCommonDir) keeping alphabetical property order, update apps/desktop/src/assistant-server/worktree-service.ts (inventoryListEntry, ghostListEntry, the PRIMARY_CHECKOUT_GATE constant), update packages/app-shell/src/hooks/use-worktree-mode.ts's test fixture only if the brief says so (the brief says useWorktreeMode itself needs no code change, only its test fixture 'entry()' gains the three default fields), run the tests to confirm GREEN (Step 6), run the full type-check per Step 7, then run ultracite fix and ultracite check exactly as Step 8 specifies. Use EXACT verbatim code from the brief — do not paraphrase or invent alternate field names or messages. IMPORTANT: do NOT commit — stop after ultracite fix/check pass and leave the working tree with changes staged or unstaged; the calling process will run additional gates and commit. If ultracite check flags noExcessiveLinesPerFile on worktree-service.ts, do NOT create worktree-adopt.ts yourself (that is Task 2's job) — instead stop and report the exact line count and violation so a human can decide, per the brief's own guidance. Report clearly at the end: files touched, test run output summary (pass counts), and any deviation from the brief with justification."

echo "=== codex exec starting at $(date) ===" > "$LOG"
(
  codex exec --cd "$WORKTREE" -s workspace-write "$PROMPT" >> "$LOG" 2>&1
  echo "EXIT_CODE:$?" >> "$LOG"
  touch "$DONE_MARKER"
) &
CODEX_PID=$!
echo "$CODEX_PID" > "$WORKTREE/.claude-scratch/codex-task1.pid"
disown

echo "codex exec launched with pid $CODEX_PID, logging to $LOG"

# Poll for completion
while [ ! -f "$DONE_MARKER" ]; do
  sleep 5
done

echo "=== codex exec finished at $(date) ==="
echo "--- log tail ---"
tail -n 200 "$LOG"
