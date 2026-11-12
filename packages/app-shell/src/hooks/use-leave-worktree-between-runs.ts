/**
 * ADR-0034: a run keeps the checkout it was admitted with, so every checkout
 * change waits for the thread's run to end. In a worktree, three folder actions
 * leave it (the thread is Local again): Make primary, Remove from this thread on
 * the worktree folder or on the Local folder, and Use another folder…. While the
 * run is in progress they say why and refuse, on the same run state the
 * checkout rows use. In Local they change no checkout and are not held.
 */
import type { WorkspaceBarRecentRoot } from '@brainstrike/assistant-ui';
import { toast } from '@brainstrike/ui';
import { useCallback } from 'react';
import type { WorkspaceBarModeComposition } from './use-workspace-bar-mode';
import { RUN_IN_PROGRESS_REASON } from './use-worktree-mode';

interface LeaveWorktreeArgs {
  /** The folder a hand-off returns to, while the thread works in a worktree. */
  readonly checkoutLocalRootId: string | undefined;
  readonly checkoutMode: 'local' | 'worktree';
  readonly onMakePrimary: (rootId: string) => void;
  readonly onRemoveFromThread: (rootId: string) => void;
  readonly onUseFolder: (folder: WorkspaceBarRecentRoot) => void;
  readonly threadState: WorkspaceBarModeComposition['threadState'];
}

interface LeaveWorktreeActions {
  /** Ready to spread into the bar's props: present only while the actions wait. */
  readonly leaveWorktreeDisabledReason?: string;
  readonly onMakePrimary: (rootId: string) => void;
  readonly onRemovePrimary: (rootId: string) => void;
  readonly onRemoveSecondary: (rootId: string) => void;
  readonly onUseFolder: (folder: WorkspaceBarRecentRoot) => void;
}

export function useLeaveWorktreeBetweenRuns(args: LeaveWorktreeArgs): LeaveWorktreeActions {
  const {
    checkoutLocalRootId,
    checkoutMode,
    onMakePrimary,
    onRemoveFromThread,
    onUseFolder,
    threadState,
  } = args;
  const reason =
    checkoutMode === 'worktree' && threadState === 'running' ? RUN_IN_PROGRESS_REASON : null;
  /** True when the action waits: the person is told why, as a checkout row tells them. */
  const refused = useCallback(
    (title: string): boolean => {
      if (reason === null) {
        return false;
      }
      toast({ description: reason, title, variant: 'destructive' });
      return true;
    },
    [reason]
  );
  const makePrimary = useCallback(
    (rootId: string) => {
      if (!refused('Could not make that folder primary')) {
        onMakePrimary(rootId);
      }
    },
    [onMakePrimary, refused]
  );
  // In a worktree the primary is the worktree folder.
  const removePrimary = useCallback(
    (rootId: string) => {
      if (!refused('Could not remove that folder from this thread')) {
        onRemoveFromThread(rootId);
      }
    },
    [onRemoveFromThread, refused]
  );
  // Only the Local folder's removal takes the thread out of its worktree.
  const removeSecondary = useCallback(
    (rootId: string) => {
      const leavesWorktree = rootId === checkoutLocalRootId;
      if (leavesWorktree && refused('Could not remove that folder from this thread')) {
        return;
      }
      onRemoveFromThread(rootId);
    },
    [checkoutLocalRootId, onRemoveFromThread, refused]
  );
  const chooseFolder = useCallback(
    (folder: WorkspaceBarRecentRoot) => {
      if (!refused('Could not use that folder')) {
        onUseFolder(folder);
      }
    },
    [onUseFolder, refused]
  );
  return {
    ...(reason === null ? {} : { leaveWorktreeDisabledReason: reason }),
    onMakePrimary: makePrimary,
    onRemovePrimary: removePrimary,
    onRemoveSecondary: removeSecondary,
    onUseFolder: chooseFolder,
  };
}
