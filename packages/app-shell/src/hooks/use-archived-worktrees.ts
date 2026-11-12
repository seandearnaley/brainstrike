/**
 * The where-control picker's Archived section (ADR-0034 decision 7): the
 * repository's archived managed worktrees, newest archive first, and Restore
 * and use.
 *
 * Restoring is the host's own `worktrees/restore`, its one writer. Using the
 * restored worktree is what Use does: mount its folder, then bind the thread
 * through the binding's own command. Like every checkout change it waits for
 * the thread's run to end. A worktree a thread is bound to is not idle, so the
 * idle-worktree cap does not archive it again while the thread works there.
 */

import { describeBoundaryFailure } from '@brainstrike/assistant-contract/boundary-failure';
import { checkoutName } from '@brainstrike/assistant-contract/thread-checkout-name';
import type {
  WorkspaceBarArchivedWorktree,
  WorkspaceBarArchivedWorktrees,
} from '@brainstrike/assistant-ui';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import type { ManagedWorktreeRow } from '@brainstrike/types';
import { useRef, useState } from 'react';
import type { WorktreesBridge } from '../worktrees/worktrees-bridge';
import { errorMessage } from './use-worktree-archive-action';

interface ArchivedListState {
  readonly entries: readonly WorkspaceBarArchivedWorktree[];
  readonly error: string | null;
  readonly loading: boolean;
}

/** The host lists only archived rows; one without an archive time breaks that contract, visibly. */
function toArchivedWorktree(row: ManagedWorktreeRow): WorkspaceBarArchivedWorktree {
  if (row.archivedAt === null) {
    throw new Error(`The archived worktree list named "${row.path}", which is not archived.`);
  }
  return {
    archivedAt: row.archivedAt,
    branch: row.branch,
    name: checkoutName(row.path),
    path: row.path,
    worktreeId: row.id,
  };
}

export function useArchivedWorktrees(input: {
  readonly bridge: WorktreesBridge | null;
  /** Why a checkout change waits now (a run in progress), or null. */
  readonly checkoutChangeDisabledReason: string | null;
  /** The thread binding's own command, the one Use takes. */
  readonly onSelectWorktree: (worktree: {
    readonly branch: string | null;
    readonly path: string;
    readonly worktreeId: string;
  }) => Promise<void>;
  readonly primaryRootId: string | null;
  readonly refreshList: () => Promise<void>;
  readonly setPending: (pending: boolean) => void;
  readonly setPickerOpen: (open: boolean) => void;
}): {
  readonly archived: WorkspaceBarArchivedWorktrees;
  /** The picker opened: read the archived worktrees again, and forget the last refusal. */
  readonly onPickerOpened: () => void;
} {
  const {
    bridge,
    checkoutChangeDisabledReason,
    onSelectWorktree,
    primaryRootId,
    refreshList,
    setPending,
    setPickerOpen,
  } = input;
  const { addRootDirectoryByPath } = useFileSystem();
  const [list, setList] = useState<ArchivedListState>({ entries: [], error: null, loading: false });
  const [refusal, setRefusal] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  // Only the latest read lands, so a slower earlier read never replaces a newer list.
  const latestRead = useRef(0);

  const refreshArchived = async (): Promise<void> => {
    if (!(bridge && primaryRootId)) {
      return;
    }
    latestRead.current += 1;
    const read = latestRead.current;
    setList((current) => ({ ...current, loading: true }));
    let next: ArchivedListState;
    try {
      const result = await bridge.listArchived({ rootId: primaryRootId });
      next = result.ok
        ? { entries: result.value.map(toArchivedWorktree), error: null, loading: false }
        : { entries: [], error: describeBoundaryFailure(result.error), loading: false };
    } catch (error) {
      next = { entries: [], error: errorMessage(error), loading: false };
    }
    if (read === latestRead.current) {
      setList(next);
    }
  };

  const restoreAndUse = async (
    activeBridge: WorktreesBridge,
    worktree: WorkspaceBarArchivedWorktree
  ): Promise<void> => {
    let result: Awaited<ReturnType<WorktreesBridge['restore']>>;
    try {
      result = await activeBridge.restore({ worktreeId: worktree.worktreeId });
    } catch (error) {
      setRefusal(`Could not restore ${worktree.name}: ${errorMessage(error)}`);
      return;
    }
    if (!result.ok) {
      setRefusal(`Could not restore ${worktree.name}: ${describeBoundaryFailure(result.error)}`);
      return;
    }
    const restored = result.value.worktree;
    try {
      const mounted = await addRootDirectoryByPath?.(restored.path);
      if (!mounted) {
        throw new Error(`The worktree at ${restored.path} could not be mounted.`);
      }
      await onSelectWorktree({
        branch: restored.branch,
        path: restored.path,
        worktreeId: restored.id,
      });
      setPickerOpen(false);
    } catch (error) {
      setRefusal(
        `Restored ${worktree.name}, but this thread could not move into it: ${errorMessage(error)}`
      );
    }
    // Restored either way: it leaves Archived and joins the worktrees Use can choose.
    await Promise.all([refreshList(), refreshArchived()]);
  };

  const onRestore = (worktree: WorkspaceBarArchivedWorktree): void => {
    if (!bridge) {
      setRefusal(`Could not restore ${worktree.name}: Worktrees are not available here.`);
      return;
    }
    if (checkoutChangeDisabledReason !== null) {
      setRefusal(`Could not restore ${worktree.name}: ${checkoutChangeDisabledReason}`);
      return;
    }
    setRefusal(null);
    setRestoringId(worktree.worktreeId);
    setPending(true);
    void restoreAndUse(bridge, worktree).finally(() => {
      setRestoringId(null);
      setPending(false);
    });
  };

  return {
    archived: {
      disabledReason: checkoutChangeDisabledReason,
      entries: list.entries,
      error: list.error,
      loading: list.loading,
      onRestore,
      refusal,
      restoringId,
    },
    onPickerOpened: () => {
      setRefusal(null);
      void refreshArchived();
    },
  };
}
