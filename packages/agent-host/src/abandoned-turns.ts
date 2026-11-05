import { randomUUID } from 'node:crypto';
import { hostRunTurnId, hostTurnStopped } from './committed-identities.ts';
import type { HostCore } from './core.ts';
import type { HostRunState } from './core-state.ts';
import { hostRunAncestors } from './run-branch.ts';

/**
 * Audit TW-3: an edit, a regenerate or a rewind grows a new branch from
 * `from` (a run, or null for the thread's start), leaving every turn below it.
 * A turn abandoned that way ends as a turn Stop ends it, so none of its workers
 * keeps writing the checkout beside the new branch. A turn the new branch
 * still holds, or one with a run active on this thread (whose fork the
 * admission refuses), is not abandoned. `undefined` follows the tip.
 */
export async function endHostAbandonedTurns(
  core: Pick<HostCore, 'stop'>,
  runs: ReadonlyMap<string, HostRunState>,
  threadId: string,
  from: string | null | undefined
): Promise<void> {
  if (from === undefined) {
    return;
  }
  const own = [...runs.values()].filter((run) => run.threadId === threadId);
  const base = from === null ? undefined : runs.get(from);
  const path = base ? [...hostRunAncestors(runs, base), base] : [];
  const kept = new Set(path.map(hostRunTurnId));
  const below = (run: HostRunState) =>
    from === null || hostRunAncestors(runs, run).some((ancestor) => ancestor.id === from);
  const abandoned = new Set(own.filter(below).map(hostRunTurnId));
  for (const turn of abandoned) {
    // A worker's thread forks inside its parent's turn, which is not its own to end.
    if (runs.get(turn)?.threadId !== threadId) {
      continue;
    }
    const turnRuns = [...runs.values()].filter((run) => hostRunTurnId(run) === turn);
    const idleHere = turnRuns.every((run) => run.threadId !== threadId || run.terminal);
    const working = turnRuns.some((run) => !run.terminal);
    if (!kept.has(turn) && idleHere && working && !hostTurnStopped(runs, turn)) {
      await core.stop({ commandId: randomUUID(), runId: turn, threadId });
    }
  }
}

/** The run a regenerate or a rewind of `userMessageId` grows its branch from. */
export function hostUserMessageParent(
  runs: ReadonlyMap<string, HostRunState>,
  threadId: string,
  userMessageId: string
): string | null | undefined {
  for (const run of runs.values()) {
    if (run.threadId === threadId && run.branch.userMessageId === userMessageId) {
      return run.branch.parentMessageId;
    }
  }
  return undefined;
}
