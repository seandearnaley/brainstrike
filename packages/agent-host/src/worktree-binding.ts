import type { ThreadWorkspaceBinding } from '@brainstrike/assistant-contract/thread-workspace-binding';
import type { HostCore } from './core.js';
import type { HostChildRuns } from './core-child-runs.js';
import type { HostRunAction } from './core-run-execution.js';
import type { HostRunState } from './core-state.js';
import type { HostEnteredWorktree } from './ports.js';

type HostBindingCommands = Pick<HostCore, 'readWorkspaceBinding' | 'updateWorkspaceBinding'>;

/**
 * ADR-0028 step 3: a root run's call binds its thread to the worktree it
 * created, through the binding's own command path, and ends the run after this
 * step; its next run is admitted there (ADR-0017: a run keeps its binding). A
 * child never moves its parent's thread, so it is offered no entry.
 */
export function hostWorktreeEntry(
  core: HostBindingCommands,
  children: Pick<HostChildRuns, 'isChild'>,
  run: HostRunState,
  action: HostRunAction
): ((worktree: HostEnteredWorktree) => Promise<void>) | undefined {
  if (children.isChild(run.threadId)) {
    return;
  }
  return async (worktree) => {
    const { binding } = core.readWorkspaceBinding(run.threadId);
    await core.updateWorkspaceBinding({
      commandId: `${action.toolCallId}-worktree`,
      patch: enteredWorktreeBinding(binding, worktree),
      threadId: run.threadId,
    });
    run.enteredWorktree = { branch: worktree.branch, path: worktree.root.path };
    run.steered = true;
  };
}

/**
 * The thread's binding once it works in `worktree`, as a person's worktree
 * hand-off writes it: the worktree is the operating root, and the folder it
 * was created from stays the checkout to return to and a secondary root.
 */
export function enteredWorktreeBinding(
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
