import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/preview';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from '@brainstrike/file-explorer-ui/shell';
import type { FileExplorerState } from '@brainstrike/types';
import { decodeFileSelection } from '@brainstrike/utils/selection-utils';
import { useCallback, useMemo } from 'react';
import {
  addChunkRange,
  type ChunkBounds,
  type CoverageState,
  chunkCoverage,
  removeChunkRange,
} from './range-math';

export interface SearchSelectionBridge {
  chunkState: (compositeKey: string, chunk: ChunkBounds) => CoverageState;
  isFileChecked: (compositeKey: string) => boolean;
  toggleChunk: (compositeKey: string, chunk: ChunkBounds, nextChecked: boolean) => void;
  toggleFile: (compositeKey: string, nextChecked: boolean) => void;
}

const makeId = (): string => crypto.randomUUID();

/**
 * Whether the compositeKey's file is selected, read the same way the explorer's
 * own tree checkboxes read it: a FOREIGN (non-focused) root's selection lives in
 * that root's folderState, while the focused root (or a null focus) uses the
 * top-level set. The guard mirrors the store's isForeignFolderMutation, so reads
 * always match where addSelectedFile/removeSelectedFile route their writes.
 */
type SelectionSlices = Pick<
  FileExplorerState,
  'currentFolderId' | 'folderStates' | 'selectedFilePaths'
>;

function isKeySelected(slices: SelectionSlices, compositeKey: string): boolean {
  const { folderId } = decodeFileSelection(compositeKey);
  const isForeign = slices.currentFolderId !== null && folderId !== slices.currentFolderId;
  const selectionSet = isForeign
    ? slices.folderStates[folderId]?.selectedFilePaths
    : slices.selectedFilePaths;
  return selectionSet?.has(compositeKey) ?? false;
}

/**
 * Bridges workspace-search checkboxes onto the SAME two stores the file-explorer's
 * own checkboxes drive: file membership -> the file-explorer selection store,
 * chunk ranges -> the workspace-context curation (tapestry) store.
 *
 * INVARIANT (no silent data loss): hand-curated userModified tapestry ranges are
 * never removed, trimmed, or absorbed by search-driven toggles (see range-math.ts);
 * deselecting a file clears only search-managed ranges.
 */
export function useSearchSelectionBridge(): SearchSelectionBridge {
  const explorerStore = useFileExplorerStoreContext();
  // Subscriptions keep isFileChecked/chunkState reactive for consumers.
  const selectedFilePaths = useFileExplorerStoreSelector((s) => s.selectedFilePaths);
  const currentFolderId = useFileExplorerStoreSelector((s) => s.currentFolderId);
  const folderStates = useFileExplorerStoreSelector((s) => s.folderStates);
  const addSelectedFile = useFileExplorerStoreSelector((s) => s.addSelectedFile);
  const removeSelectedFile = useFileExplorerStoreSelector((s) => s.removeSelectedFile);
  const tapestryRangesByKey = useWorkspaceContextCurationStore((s) => s.tapestryRangesByKey);
  const setTapestryRangesForKey = useWorkspaceContextCurationStore(
    (s) => s.setTapestryRangesForKey
  );

  const isFileChecked = useCallback(
    (compositeKey: string): boolean =>
      isKeySelected({ currentFolderId, folderStates, selectedFilePaths }, compositeKey),
    [currentFolderId, folderStates, selectedFilePaths]
  );

  const chunkState = useCallback(
    (compositeKey: string, chunk: ChunkBounds): CoverageState =>
      chunkCoverage(isFileChecked(compositeKey), tapestryRangesByKey[compositeKey], chunk),
    [isFileChecked, tapestryRangesByKey]
  );

  const toggleFile = useCallback(
    (compositeKey: string, nextChecked: boolean): void => {
      const { folderId, path } = decodeFileSelection(compositeKey);
      if (nextChecked) {
        addSelectedFile(folderId, path);
        return;
      }
      removeSelectedFile(folderId, path);
      // Clear search-managed ranges; hand-curated (userModified) ranges survive.
      const existing =
        useWorkspaceContextCurationStore.getState().tapestryRangesByKey[compositeKey] ?? [];
      setTapestryRangesForKey(
        compositeKey,
        existing.filter((range) => range.userModified)
      );
    },
    [addSelectedFile, removeSelectedFile, setTapestryRangesForKey]
  );

  const toggleChunk = useCallback(
    (compositeKey: string, chunk: ChunkBounds, nextChecked: boolean): void => {
      const existing =
        useWorkspaceContextCurationStore.getState().tapestryRangesByKey[compositeKey] ?? [];
      if (nextChecked) {
        // Chunk selection implies file membership.
        if (!isKeySelected(explorerStore.getState(), compositeKey)) {
          const { folderId, path } = decodeFileSelection(compositeKey);
          addSelectedFile(folderId, path);
        }
        setTapestryRangesForKey(compositeKey, addChunkRange(existing, chunk, makeId));
        return;
      }
      setTapestryRangesForKey(compositeKey, removeChunkRange(existing, chunk));
    },
    [explorerStore, addSelectedFile, setTapestryRangesForKey]
  );

  return useMemo(
    () => ({ chunkState, isFileChecked, toggleChunk, toggleFile }),
    [chunkState, isFileChecked, toggleChunk, toggleFile]
  );
}
