/**
 * New worktree… in one click (ADR-0034, BST-2506). The where-control's row
 * makes a worktree with the defaults Automatic isolation uses (from the
 * checkout's last commit, named by the host, on `bs/<name>`) and moves the
 * thread into it through the create sheet's own `onCreate`. So it waits for the
 * thread's run to end, mounts the folder, binds the thread and toasts as the
 * sheet's Create does.
 *
 * The one exception is a repository whose setup script has no answer yet: the
 * host would make the worktree and skip the script, and only the sheet asks.
 * Then nothing is created, and the row opens the sheet on the context it read.
 *
 * The sheet says where the folder's uncommitted changes stay; with no sheet,
 * the person is told once the thread is in the new worktree.
 */
import type {
  WorkspaceBarCreateWorktreeRequest,
  WorkspaceBarQuickCreateOutcome,
} from '@brainstrike/assistant-ui';
import {
  DEFAULT_WORKTREE_BASE_REF,
  WORKTREE_BRANCH_PREFIX,
  type WorktreeCreateContext,
} from '@brainstrike/types';
import { toast } from '@brainstrike/ui';

export interface UseQuickWorktreeArgs {
  /** Creates, mounts and binds, with the create sheet's checks and toasts. */
  readonly onCreate: (request: WorkspaceBarCreateWorktreeRequest) => Promise<void>;
  /**
   * Reads the host's create context and keeps it for the create sheet. Rejects,
   * after its own toast, when the thread cannot move now.
   */
  readonly readCreateContext: () => Promise<WorktreeCreateContext>;
  /** The folder the thread leaves when it has uncommitted changes; null when it has none. */
  readonly uncommittedFolderName: string | null;
}

export function useQuickWorktree({
  onCreate,
  readCreateContext,
  uncommittedFolderName,
}: UseQuickWorktreeArgs): () => Promise<WorkspaceBarQuickCreateOutcome> {
  return async () => {
    const { repositorySetup, suggestedName } = await readCreateContext();
    if (repositorySetup?.decision === null) {
      return { needsSheet: true };
    }
    await onCreate({
      baseRef: DEFAULT_WORKTREE_BASE_REF,
      branch: { name: `${WORKTREE_BRANCH_PREFIX}${suggestedName}` },
      name: suggestedName,
    });
    if (uncommittedFolderName) {
      toast({
        description: `The worktree ${suggestedName} starts from the last commit, so your uncommitted changes stay in ${uncommittedFolderName}.`,
        title: `Uncommitted changes stayed in ${uncommittedFolderName}`,
      });
    }
    return { needsSheet: false };
  };
}
