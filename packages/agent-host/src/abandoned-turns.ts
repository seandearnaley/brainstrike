import { randomUUID } from 'node:crypto';
import { hostRunTurnId, hostTurnStopped } from './committed-identities.ts';
import type { HostCore } from './core.ts';
import type { HostRunState } from './core-state.ts';
import { hostRunAncestors } from './run-branch.ts';

/**
 * The run an edit, a regenerate or a rewind grows its branch from: null for
 * the thread's start, undefined for the tip. It throws when the command would
 * be refused, and the command itself then reports that refusal.
 */
export type HostForkPoint = () => string | null | undefined | Promise<string | null | undefined>;

/**
 * Audit TW-3: an edit, a regenerate or a rewind grows a new branch from
 * its fork point, leaving every turn below it.
 * A turn abandoned that way ends as a turn Stop ends it, so none of its workers
 * keeps writing the checkout beside the new branch. A turn the new branch
 * still holds, or one with a run active on this thread (whose fork the
 * admission refuses), is not abandoned, and a command that will be refused
 * ends nothing.
 */
export async function endHostAbandonedTurns(
  core: Pick<HostCore, 'stop'>,
  runs: ReadonlyMap<string, HostRunState>,
  threadId: string,
  fork: HostForkPoint | undefined
): Promise<void> {
  let from: string | null | undefined;
  try {
    from = await fork?.();
  } catch {
    return;
  }
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

/**
 * Where a start or a regenerate forks, read once the thread has settled. A
 * parent or message the thread does not hold has no turn below it, so a fork
 * from one ends nothing.
 */
export function hostRunFork(
  runs: ReadonlyMap<string, HostRunState>,
  params:
    | { readonly parentMessageId?: string | null | undefined }
    | { readonly threadId: string; readonly userMessageId: string }
): HostForkPoint {
  return () =>
    'userMessageId' in params ? hostUserMessageParent(runs, params) : params.parentMessageId;
}

/** The run a regenerate of `userMessageId` grows its branch from. */
function hostUserMessageParent(
  runs: ReadonlyMap<string, HostRunState>,
  params: { readonly threadId: string; readonly userMessageId: string }
): string | null | undefined {
  for (const run of runs.values()) {
    if (run.threadId === params.threadId && run.branch.userMessageId === params.userMessageId) {
      return run.branch.parentMessageId;
    }
  }
  return undefined;
}
