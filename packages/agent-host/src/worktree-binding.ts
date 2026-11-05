import type { ThreadWorkspaceBinding } from '@brainstrike/assistant-contract/thread-workspace-binding';
import type { HostCore } from './core.ts';
import type { HostChildRuns } from './core-child-runs.ts';
import type { HostRunAction } from './core-run-execution.ts';
import type { HostRunState } from './core-state.ts';
import type { HostEnteredWorktree } from './ports.ts';
import type { HostEvent } from './protocol.ts';

type HostBindingCommands = Pick<HostCore, 'readWorkspaceBinding' | 'updateWorkspaceBinding'>;
type HostWorktreeChildren = Pick<HostChildRuns, 'isChild' | 'subtree'>;

/** Rule 5 at the entry, when a parallel call of the same step dispatched a worker. */
const WORKERS_LIVE =
  'The worktree was created, but this conversation stays in its checkout: a background worker started in the same step still writes there.';

/**
 * ADR-0028 step 3: a root run's call binds its thread to the worktree it
 * created, through the binding's own command path, naming the run; folding that
 * commit ends the run after this step. Its next run is admitted there
 * (ADR-0017: a run keeps its binding). A child never moves its parent's
 * thread, and a root never moves away from workers still writing its checkout
 * (rule 5: one operating root), so neither is offered an entry.
 */
export function hostWorktreeEntry(
  core: HostBindingCommands,
  children: HostWorktreeChildren,
  runs: ReadonlyMap<string, HostRunState>,
  run: HostRunState,
  action: HostRunAction
): ((worktree: HostEnteredWorktree) => Promise<void>) | undefined {
  if (children.isChild(run.threadId) || workersLive(children, runs, run.threadId)) {
    return;
  }
  return async (worktree) => {
    if (workersLive(children, runs, run.threadId)) {
      throw new Error(WORKERS_LIVE);
    }
    const { binding } = core.readWorkspaceBinding(run.threadId);
    await core.updateWorkspaceBinding(
      {
        commandId: `${action.toolCallId}-worktree`,
        patch: enteredWorktreeBinding(binding, worktree),
        threadId: run.threadId,
      },
      { runId: run.id }
    );
  };
}

function workersLive(
  children: HostWorktreeChildren,
  runs: ReadonlyMap<string, HostRunState>,
  threadId: string
): boolean {
  const workers = new Set(children.subtree(threadId).filter((id) => id !== threadId));
  return [...runs.values()].some((other) => !other.terminal && workers.has(other.threadId));
}

/**
 * The committed entry, live and on replay: the run that moved its thread into a
 * worktree ends after that step and continues there, so a host that restarts
 * mid-step recovers the same boundary rather than acting in the old checkout.
 */
export function foldHostWorktreeEntry(
  runs: ReadonlyMap<string, HostRunState>,
  event: Extract<HostEvent, { type: 'workspace.binding.updated' }>
): void {
  const run = event.enteredBy ? runs.get(event.enteredBy.runId) : undefined;
  if (!run) {
    return;
  }
  const path = event.binding.operatingRootPath;
  if (!path) {
    throw new Error('A committed worktree entry names no operating root path.');
  }
  run.enteredWorktree = { branch: event.binding.checkoutBranch ?? null, path };
  run.steered = true;
}

/**
 * The thread's binding once it works in `worktree`, as a person's worktree
 * hand-off writes it: the worktree is the operating root, and the folder it
 * was created from stays the checkout to return to and a secondary root.
 */
function enteredWorktreeBinding(
  current: ThreadWorkspaceBinding | null,
  worktree: HostEnteredWorktree
): ThreadWorkspaceBinding {
  const previous = current?.operatingRootId;
  const local =
    current?.checkoutMode === 'worktree'
      ? (current.checkoutLocalRootId ?? worktree.localRootId)
      : (previous ?? worktree.localRootId);
  const secondary = [
    ...(current?.secondaryRootIds ?? []),
    ...(previous ? [previous] : [worktree.localRootId]),
  ].filter((rootId) => rootId !== worktree.root.rootId);
  return {
    ...(worktree.branch ? { checkoutBranch: worktree.branch } : {}),
    checkoutLocalRootId: local,
    checkoutMode: 'worktree',
    checkoutWorktreeId: worktree.worktreeId,
    checkoutWorktreePath: worktree.root.path,
    operatingRootDisplayName: worktree.root.displayName,
    operatingRootId: worktree.root.rootId,
    operatingRootPath: worktree.root.path,
    secondaryRootIds: [...new Set(secondary)],
  };
}
