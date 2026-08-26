/** Workspace-bar composition for the thread checkout mode. */
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type {
  WorkspaceBarBranchMenu,
  WorkspaceBarCheckout,
  WorkspaceBarMode,
} from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { useCallback } from 'react';
import { useBranchSwitcher } from './use-branch-switcher';
import type { ThreadCheckoutState } from './use-thread-checkout';
import { useWorktreeMode } from './use-worktree-mode';

const logger = createLogger('WorkspaceBarMode');

export interface UseWorkspaceBarModeArgs {
  readonly checkout: WorkspaceBarCheckout | undefined;
  readonly onHandOffToLocal: () => Promise<void>;
  readonly onSelectWorktree: (worktree: {
    readonly branch: string | null;
    readonly path: string;
    readonly worktreeId: string;
  }) => Promise<void>;
  readonly primaryRootId: string | undefined;
  readonly primaryRootPath: string | undefined;
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
    onHandOffToLocal,
    onSelectWorktree,
    primaryRootId,
    primaryRootPath,
    selectedThread,
    worktreeCheckout,
  } = args;
  // `latestRun` is populated from the durable run ledger after the first request.
  const hasSentFirstRequest = selectedThread?.latestRun !== undefined;
  const activeRunId =
    selectedThread?.latestRun?.status === 'running' ? selectedThread.latestRun.id : null;

  const mode = useWorktreeMode({
    checkout: worktreeCheckout,
    hasSentFirstRequest,
    isRepository: checkout !== undefined,
    onHandOffToLocal,
    onSelectWorktree,
    primaryRootId: primaryRootId ?? null,
    primaryRootPath: primaryRootPath ?? null,
    runId: activeRunId,
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
