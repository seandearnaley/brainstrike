/** Workspace-bar composition for the thread checkout mode. */
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type {
  WorkspaceBarBranchMenu,
  WorkspaceBarCheckout,
  WorkspaceBarMode,
} from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { toast } from '@brainstrike/ui';
import { useCallback, useEffect, useRef } from 'react';
import { useWorktreeCheckoutIntentStore } from '../stores/worktree-checkout-intent-store';
import { useBranchSwitcher } from './use-branch-switcher';
import type { ThreadCheckoutState } from './use-thread-checkout';
import { useWorktreeMode } from './use-worktree-mode';

const logger = createLogger('WorkspaceBarMode');

export interface UseWorkspaceBarModeArgs {
  readonly checkout: WorkspaceBarCheckout | undefined;
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
  readonly mode: WorkspaceBarMode | undefined;
}

/** `feature/alpha` → `feature-alpha`: a branch name is not a path segment. */
function branchToName(branch: string): string {
  return branch.replaceAll('/', '-');
}

export function useWorkspaceBarMode(args: UseWorkspaceBarModeArgs): WorkspaceBarModeComposition {
  const {
    checkout,
    foldersPending,
    onHandOffToLocal,
    onSelectWorktree,
    primaryRootId,
    primaryRootPath,
    selectedMemoryThreadId,
    selectedThread,
    worktreeCheckout,
  } = args;
  // Apply a Worktree Map intent to the SELECTED thread, once. `consume` clears
  // the entry, so a re-render cannot re-apply it; a failure surfaces through
  // the same toast path the chip uses and the intent is not retried.
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
    applyingRef.current = true;
    const applied = intent.worktreeId
      ? onSelectWorktree({
          branch: intent.branch,
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
  ]);
  // `latestRun` is populated from the durable run ledger after the first request.
  // A known id with no row is still hydrating, not evidence that no request was sent.
  const firstRequestState =
    selectedMemoryThreadId === undefined
      ? 'no-thread'
      : selectedThread === undefined
        ? 'loading'
        : selectedThread.latestRun === undefined
          ? 'unsent'
          : 'sent';
  const activeRunId =
    selectedThread?.latestRun?.status === 'running' ? selectedThread.latestRun.id : null;

  const mode = useWorktreeMode({
    checkout: worktreeCheckout,
    firstRequestState,
    isRepository: checkout !== undefined,
    onHandOffToLocal,
    onSelectWorktree,
    primaryRootId: primaryRootId ?? null,
    primaryRootPath: primaryRootPath ?? null,
    runId: activeRunId,
    threadId: selectedMemoryThreadId ?? null,
  });
  const onSwitchInNewWorktree = useCallback(
    (branch: string): void => {
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
    },
    [mode]
  );
  const branchSwitcher = useBranchSwitcher({
    checkout,
    dbRootId: primaryRootId ?? null,
    ...(mode && mode.createDisabledReason === null ? { onSwitchInNewWorktree } : {}),
  });
  return { branchSwitcher, mode };
}
