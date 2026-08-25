/**
 * Workspace-bar composition for the thread checkout mode. The present task
 * owns these metadata writes until the dedicated thread-checkout hook lands.
 */
import type {
  AssistantMemoryThread,
  AssistantThreadMetadata,
  AssistantThreadRepository,
} from '@brainstrike/assistant-data';
import type {
  WorkspaceBarBranchMenu,
  WorkspaceBarCheckout,
  WorkspaceBarMode,
} from '@brainstrike/assistant-ui';
import { useCallback } from 'react';
import { useBranchSwitcher } from './use-branch-switcher';
import { useWorktreeMode } from './use-worktree-mode';

type UpdateThreadMetadata = (
  repository: AssistantThreadRepository,
  resourceId: string,
  threadId: string,
  metadata: AssistantThreadMetadata
) => Promise<void>;

export interface UseWorkspaceBarModeArgs {
  readonly assistantThreadRepository: AssistantThreadRepository | null;
  readonly checkout: WorkspaceBarCheckout | undefined;
  readonly memoryResourceId: string;
  readonly primaryRootId: string | undefined;
  readonly primaryRootPath: string | undefined;
  readonly selectedMemoryThreadId: string | undefined;
  readonly selectedThread: AssistantMemoryThread | undefined;
  readonly updateThreadMetadata: UpdateThreadMetadata;
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
    assistantThreadRepository,
    checkout,
    memoryResourceId,
    primaryRootId,
    primaryRootPath,
    selectedMemoryThreadId,
    selectedThread,
    updateThreadMetadata,
  } = args;
  const worktreeCheckout = {
    mode: selectedThread?.metadata?.checkoutMode ?? 'local',
    worktreeId: selectedThread?.metadata?.checkoutWorktreeId ?? null,
  };
  const onSelectWorktree = useCallback(
    async (worktree: { branch: string | null; path: string; worktreeId: string }) => {
      if (!(assistantThreadRepository && selectedMemoryThreadId)) {
        throw new Error('Cannot switch checkout without an active thread.');
      }
      await updateThreadMetadata(
        assistantThreadRepository,
        memoryResourceId,
        selectedMemoryThreadId,
        {
          checkoutMode: 'worktree',
          checkoutWorktreeId: worktree.worktreeId,
          checkoutWorktreePath: worktree.path,
          ...(worktree.branch ? { checkoutBranch: worktree.branch } : {}),
        }
      );
    },
    [assistantThreadRepository, memoryResourceId, selectedMemoryThreadId, updateThreadMetadata]
  );
  const onHandOffToLocal = useCallback(async () => {
    if (!(assistantThreadRepository && selectedMemoryThreadId)) {
      throw new Error('Cannot hand off to local without an active thread.');
    }
    await updateThreadMetadata(
      assistantThreadRepository,
      memoryResourceId,
      selectedMemoryThreadId,
      { checkoutMode: 'local' }
    );
  }, [assistantThreadRepository, memoryResourceId, selectedMemoryThreadId, updateThreadMetadata]);
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
      void mode?.onCreate({
        baseRef: branch,
        branch: { detached: true },
        name: branchToName(branch),
      });
    },
    [mode]
  );
  const branchSwitcher = useBranchSwitcher({
    checkout,
    dbRootId: primaryRootId ?? null,
    ...(mode ? { onSwitchInNewWorktree } : {}),
  });
  return { branchSwitcher, mode };
}
