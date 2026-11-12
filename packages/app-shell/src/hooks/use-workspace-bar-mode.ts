/** Workspace-bar composition for the thread checkout mode. */
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type {
  WorkspaceBarBranchMenu,
  WorkspaceBarCheckout,
  WorkspaceBarMode,
} from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { toast } from '@brainstrike/ui';
import { useEffect, useRef } from 'react';
import { useAssistantThreadHostRuns } from '../assistant-thread-host-context';
import { useWorktreeCheckoutIntentStore } from '../stores/worktree-checkout-intent-store';
import { useBranchSwitcher } from './use-branch-switcher';
import type { ThreadCheckoutState } from './use-thread-checkout';
import { toastFailure } from './use-worktree-archive-action';
import {
  RUN_IN_PROGRESS_REASON,
  type UseWorktreeModeArgs,
  useWorktreeMode,
} from './use-worktree-mode';

const logger = createLogger('WorkspaceBarMode');

export interface UseWorkspaceBarModeArgs {
  readonly checkout: WorkspaceBarCheckout | undefined;
  /** Why the primary root's status read failed, or null (`useThreadCheckoutStatus`). */
  readonly checkoutFailure: string | null;
  /**
   * Whether the primary root's first git status read has settled
   * (`useThreadCheckoutStatus`). Until it has, an undefined `checkout` means
   * "not known yet", not "not a git repository".
   */
  readonly checkoutSettled: boolean;
  /**
   * True while the selected thread's folder set is still resolving (its
   * binding metadata, or the MAIN-root fallback for an unbound thread). A
   * Worktree Map intent waits for it: a bind derived before the primary folder
   * resolves would refuse with "the current primary folder is no longer
   * available" for a folder that is merely loading.
   */
  readonly foldersPending: boolean;
  readonly onHandOffToLocal: () => Promise<void>;
  readonly onSelectWorktree: (worktree: {
    readonly branch: string | null;
    /** The repository's open folder, which a thread with no folder returns to on hand-off. */
    readonly localRoot?: {
      readonly displayName: string;
      readonly path: string;
      readonly rootId: string;
    };
    readonly path: string;
    readonly worktreeId: string;
  }) => Promise<void>;
  readonly primaryRootId: string | undefined;
  readonly primaryRootPath: string | undefined;
  readonly selectedMemoryThreadId: string | undefined;
  readonly selectedThread: AssistantMemoryThread | undefined;
  readonly worktreeCheckout: ThreadCheckoutState;
}

export interface WorkspaceBarModeComposition {
  readonly branchSwitcher: WorkspaceBarBranchMenu | undefined;
  /** Whether `branchSwitcher` is this root's answer yet (`BranchSwitcher.settled`). */
  readonly branchSwitcherSettled: boolean;
  readonly mode: WorkspaceBarMode | undefined;
  /**
   * The selected thread as a checkout change sees it, the one read the checkout
   * rows gate on. Make primary, which can leave a worktree, gates on it too.
   */
  readonly threadState: UseWorktreeModeArgs['threadState'];
}

/** `feature/alpha` → `feature-alpha`: a branch name is not a path segment. */
function branchToName(branch: string): string {
  return branch.replaceAll('/', '-');
}

export function useWorkspaceBarMode(args: UseWorkspaceBarModeArgs): WorkspaceBarModeComposition {
  const {
    checkout,
    checkoutFailure,
    checkoutSettled,
    foldersPending,
    onHandOffToLocal,
    onSelectWorktree,
    primaryRootId,
    primaryRootPath,
    selectedMemoryThreadId,
    selectedThread,
    worktreeCheckout,
  } = args;
  // The host's committed run state, as the Threads panel reads it: current
  // while the thread is open. A thread the host does not report keeps its
  // catalog row's latest run. A known id with no row is still hydrating.
  const hostRuns = useAssistantThreadHostRuns();
  const latestRun = selectedThread
    ? (hostRuns.get(selectedThread.id) ?? selectedThread.latestRun)
    : undefined;
  const threadState =
    selectedMemoryThreadId === undefined
      ? 'no-thread'
      : selectedThread === undefined
        ? 'loading'
        : latestRun?.status === 'running' || latestRun?.status === 'cancelling'
          ? 'running'
          : 'idle';
  // Apply a Worktree Map intent to the SELECTED thread, once. `consume` clears
  // the entry, so a re-render cannot re-apply it; a failure surfaces through
  // the same toast path the chip uses and the intent is not retried. A thread
  // whose run is in progress keeps its checkout (ADR-0034): the intent is
  // refused as the chip refuses it. "New thread here" targets the thread it
  // just created, which has no run, so this never refuses it.
  const pendingIntent = useWorktreeCheckoutIntentStore((state) => state.pending);
  const consumeIntent = useWorktreeCheckoutIntentStore((state) => state.consume);
  const applyingRef = useRef(false);
  useEffect(() => {
    const threadId = selectedThread?.id;
    if (
      !threadId ||
      pendingIntent?.threadId !== threadId ||
      applyingRef.current ||
      foldersPending
    ) {
      return;
    }
    const intent = consumeIntent(threadId);
    if (!intent) {
      return;
    }
    if (threadState === 'running') {
      toastFailure(
        intent.worktreeId ? 'Could not use that worktree' : 'Could not hand off to Local',
        RUN_IN_PROGRESS_REASON
      );
      return;
    }
    applyingRef.current = true;
    const applied = intent.worktreeId
      ? onSelectWorktree({
          branch: intent.branch,
          ...(intent.localRoot ? { localRoot: intent.localRoot } : {}),
          path: intent.path,
          worktreeId: intent.worktreeId,
        })
      : onHandOffToLocal();
    const failureTitle = intent.worktreeId
      ? "The thread didn't move into the worktree"
      : "The thread didn't hand off to Local";
    void applied
      .catch((error: unknown) => {
        logger.error('worktree map checkout intent failed', { error, threadId });
        toast({
          description: error instanceof Error ? error.message : String(error),
          title: failureTitle,
          variant: 'destructive',
        });
      })
      .finally(() => {
        applyingRef.current = false;
      });
  }, [
    consumeIntent,
    foldersPending,
    onHandOffToLocal,
    onSelectWorktree,
    pendingIntent,
    selectedThread?.id,
    threadState,
  ]);

  const resolvedMode = useWorktreeMode({
    checkout: worktreeCheckout,
    isRepository: checkout !== undefined,
    onHandOffToLocal,
    onSelectWorktree,
    primaryRootId: primaryRootId ?? null,
    primaryRootPath: primaryRootPath ?? null,
    statusFailure: checkoutFailure,
    threadId: selectedMemoryThreadId ?? null,
    threadState,
    uncommittedChanges: checkout?.dirty === true,
  });
  // While the root's first status read is in flight, `isRepository` above is
  // false only because nothing is known yet. Withhold the chip until it
  // settles, as the Branch row does (BST-1400), instead of briefly offering
  // the "Not a git repository" diagnostic (BST-2129).
  const mode = checkoutSettled ? resolvedMode : undefined;
  const onSwitchInNewWorktree = (branch: string): void => {
    if (!mode) {
      return;
    }
    void mode
      .onCreate({
        baseRef: branch,
        branch: { detached: true },
        name: branchToName(branch),
      })
      .catch((error: unknown) => {
        logger.error('Switch in a new worktree failed', { error });
      });
  };
  const { menu: branchSwitcher, settled: branchSwitcherSettled } = useBranchSwitcher({
    checkout,
    dbRootId: primaryRootId ?? null,
    ...(mode && mode.createDisabledReason === null ? { onSwitchInNewWorktree } : {}),
  });
  return { branchSwitcher, branchSwitcherSettled, mode, threadState };
}
