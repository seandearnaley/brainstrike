/**
 * Everything the Threads panel's folder grouping reads beyond the threads
 * themselves (ADR-0034 decision 3), made only while that grouping shows:
 * entering it is the gesture, and the other groupings place no thread by
 * folder or repository.
 *
 * Two reads, ONE of each for the whole panel and never one per row:
 * - the host's worktree listing, which says which repository each checkout
 *   belongs to (`useThreadRepositoryListing`);
 * - the `roots` rows behind the section names (`useThreadFolderRows`).
 */
import {
  type AssistantMemoryThread,
  useAssistantThreadGroupsStore,
} from '@brainstrike/assistant-data';
import type { WorktreeListEntry } from '@brainstrike/types';
import { useEffect } from 'react';
import type { ThreadPanelFolderGroupingState } from '../thread-panel-content-state';
import { listFolderGroupingRootIds } from '../thread-repositories';
import { type ThreadFolderRowsState, useThreadFolderRows } from './use-thread-folder-rows';
import { useThreadRepositoryListing } from './use-thread-repository-listing';

const NO_ROOT_IDS: readonly string[] = [];

export interface ThreadFolderGrouping {
  readonly folderRowsByRootId: ThreadFolderRowsState['rowsByRootId'];
  /**
   * The repositories could not be read. The sections then group by folder
   * alone, and the panel says so instead of presenting that as the answer.
   */
  readonly repositoriesError: string | null;
  /** The host's worktree listing; `null` names no repository (see `mapThreadRepositories`). */
  readonly repositoryEntries: readonly WorktreeListEntry[] | null;
  /**
   * What stands in for the tree while folder grouping cannot be drawn
   * honestly, or `null` outside folder grouping.
   *
   * An unresolved or failed folder map is EMPTY, and an empty map files every
   * thread under "No folder", so both replace the tree. So does the first read
   * of the repositories: sections drawn before it would show a worktree as a
   * folder of its own, then move its threads.
   */
  readonly state: ThreadPanelFolderGroupingState | null;
}

export function useThreadFolderGrouping({
  enabled,
  threads,
}: {
  /** True only while folder grouping shows. */
  readonly enabled: boolean;
  readonly threads: readonly AssistantMemoryThread[];
}): ThreadFolderGrouping {
  const repositoryListing = useThreadRepositoryListing({ enabled });
  const folderRows = useThreadFolderRows(
    enabled ? listFolderGroupingRootIds(threads, repositoryListing.entries) : NO_ROOT_IDS
  );

  // Folder sections mint persisted collapse keys; this is the symmetric prune
  // to the one `deleteGroup` does for group keys. The RESOLVED folder rows are
  // the only honest live-root evidence the panel has — an empty map also means
  // "still loading", "the folder query failed", or "not in folder grouping at
  // all", and pruning on any of those would wipe every folder's collapse state.
  const pruneFolderCollapseIds = useAssistantThreadGroupsStore(
    (state) => state.pruneFolderCollapseIds
  );
  const folderRowsByRootId = folderRows.rowsByRootId;
  const folderRowsResolved = !(folderRows.loading || folderRows.error);
  useEffect(() => {
    if (!(folderRowsResolved && folderRowsByRootId.size > 0)) {
      return;
    }
    pruneFolderCollapseIds([...folderRowsByRootId.keys()]);
  }, [folderRowsByRootId, folderRowsResolved, pruneFolderCollapseIds]);

  return {
    folderRowsByRootId,
    repositoriesError: repositoryListing.error,
    repositoryEntries: repositoryListing.entries,
    state: enabled
      ? { error: folderRows.error, loading: folderRows.loading || repositoryListing.loading }
      : null,
  };
}
