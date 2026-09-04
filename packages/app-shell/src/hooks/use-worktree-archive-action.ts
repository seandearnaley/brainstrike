import type { WorktreeArchiveConfirmation } from '@brainstrike/assistant-ui/worktree-archive-confirmation-dialog';
import type { WorktreeArchivePreview } from '@brainstrike/types';
import { toast } from '@brainstrike/ui';
import { useCallback, useMemo, useState } from 'react';
import type { WorktreesBridge } from '../worktrees/worktrees-bridge';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toastFailure(title: string, description: string): void {
  toast({ description, title, variant: 'destructive' });
}

export function useWorktreeArchiveAction(input: {
  readonly bridge: WorktreesBridge | null;
  readonly onHandOffToLocal: () => Promise<void>;
  readonly refreshList: () => Promise<void>;
  readonly runId: string | null;
  readonly setPending: (pending: boolean) => void;
  readonly threadId: string | null;
  readonly worktreeId: string | null;
  readonly worktreeName: string;
}): {
  readonly archiveConfirmation: WorktreeArchiveConfirmation | null;
  readonly onArchive: () => void;
} {
  const {
    bridge,
    onHandOffToLocal,
    refreshList,
    runId,
    setPending,
    threadId,
    worktreeId,
    worktreeName,
  } = input;
  const archiveWorktree = useCallback(
    async (confirmIgnoredEntries?: string): Promise<void> => {
      if (!(bridge && threadId && worktreeId)) {
        return;
      }
      try {
        // Hand-off MUST precede archive. If hand-off fails, the worktree is untouched.
        // If archive then fails, the thread is safely Local; reversing the order can
        // strand a thread on a checkout that has already been removed.
        await onHandOffToLocal();
      } catch (error) {
        toastFailure('Could not hand off to Local — worktree not archived', errorMessage(error));
        return;
      }
      try {
        const result = await bridge.archive({
          ...(confirmIgnoredEntries ? { confirmIgnoredEntries } : {}),
          worktreeId,
          ...(runId ? { runId } : {}),
        });
        if (!result.ok) {
          toastFailure('Thread handed off — worktree not archived', result.error);
          return;
        }
        await refreshList();
      } catch (error) {
        toastFailure('Thread handed off — worktree not archived', errorMessage(error));
      }
    },
    [bridge, onHandOffToLocal, refreshList, runId, threadId, worktreeId]
  );
  const [confirmation, setConfirmation] = useState<{
    readonly archiveWorktree: typeof archiveWorktree;
    readonly preview: WorktreeArchivePreview;
    readonly threadId: string | null;
    readonly worktreeId: string;
    readonly worktreeName: string;
  } | null>(null);
  // Callback identity changes on every thread/worktree transition. Requiring the
  // initiating callback as well as explicit ids makes stale state non-resurrectable.
  const currentConfirmation =
    confirmation?.archiveWorktree === archiveWorktree &&
    confirmation.threadId === threadId &&
    confirmation.worktreeId === worktreeId
      ? confirmation
      : null;

  const onArchive = useCallback((): void => {
    if (!(bridge && worktreeId)) {
      return;
    }
    setPending(true);
    void bridge
      .inspectArchive({ worktreeId })
      .then(async (result) => {
        if (!result.ok) {
          toastFailure('Could not inspect worktree for archive', result.error);
          return;
        }
        if (result.value.ignoredEntryCount === 0) {
          await archiveWorktree();
          return;
        }
        if (result.value.confirmationToken === null) {
          throw new Error('Archive inspection did not provide an ignored-file confirmation token.');
        }
        setConfirmation({
          archiveWorktree,
          preview: result.value,
          threadId,
          worktreeId,
          worktreeName,
        });
      })
      .catch((error: unknown) => {
        toastFailure('Could not inspect worktree for archive', errorMessage(error));
      })
      .finally(() => setPending(false));
  }, [archiveWorktree, bridge, setPending, threadId, worktreeId, worktreeName]);

  const archiveConfirmation = useMemo<WorktreeArchiveConfirmation | null>(() => {
    if (!currentConfirmation) {
      return null;
    }
    return {
      onCancel: () => setConfirmation(null),
      onConfirm: () => {
        const confirmationToken = currentConfirmation.preview.confirmationToken;
        if (confirmationToken === null) {
          toastFailure(
            'Could not archive worktree',
            'Archive inspection did not provide an ignored-file confirmation token.'
          );
          return;
        }
        setConfirmation(null);
        setPending(true);
        void currentConfirmation
          .archiveWorktree(confirmationToken)
          .finally(() => setPending(false));
      },
      preview: currentConfirmation.preview,
      worktreeName: currentConfirmation.worktreeName,
    };
  }, [currentConfirmation, setPending]);

  return { archiveConfirmation, onArchive };
}
