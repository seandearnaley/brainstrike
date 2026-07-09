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
  toTapestrySpan,
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
 * INVARIANT (no silent data loss): search-driven toggles mutate ONLY the bridge's
 * own `origin:'search'` ranges (see range-math.ts). Hand-curated userModified ranges
 * AND the preview panel's auto-created full-file default (origin undefined) are never
 * removed, trimmed, or absorbed; deselecting a file clears only search-owned ranges.
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
      // Clear only the bridge's own `origin:'search'` ranges; hand-curated
      // userModified ranges AND the auto-created full-file default survive.
      const existing =
        useWorkspaceContextCurationStore.getState().tapestryRangesByKey[compositeKey] ?? [];
      setTapestryRangesForKey(
        compositeKey,
        existing.filter((range) => range.origin !== 'search')
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
      // KNOWN ASYMMETRY (defensible, intentional): the range model can't express
      // "whole file minus one chunk". If the chunk's coverage comes from a NON
      // search-owned range — the explorer/preview auto-created full-file default,
      // a hand-curated userModified range, or the zero-range whole-file selection
      // (chunkCoverage's zero-ranges 'checked' rule) — there is nothing the bridge
      // may trim (it only mutates its own `origin:'search'` ranges). So unchecking
      // deselects the ENTIRE file and clears only the bridge's own ranges, leaving
      // the default + userModified ranges verbatim.
      const span = toTapestrySpan(chunk);
      const nonSearchCoversChunk = existing.some(
        (range) =>
          range.isActive &&
          range.origin !== 'search' &&
          range.startLine < span.endLine &&
          range.endLine > span.startLine
      );
      if (nonSearchCoversChunk || existing.length === 0) {
        if (isKeySelected(explorerStore.getState(), compositeKey)) {
          const { folderId, path } = decodeFileSelection(compositeKey);
          removeSelectedFile(folderId, path);
        }
        setTapestryRangesForKey(
          compositeKey,
          existing.filter((range) => range.origin !== 'search')
        );
        return;
      }

      const updated = removeChunkRange(existing, chunk);
      setTapestryRangesForKey(compositeKey, updated);
      // Idempotence guard (check -> uncheck must return to the start): toggleChunk(true)
      // auto-selects the file, so if unchecking removes the last range that kept the file
      // in context we must ALSO deselect the file. Otherwise a selected file with zero
      // active ranges reads as whole-file 'checked' (chunkCoverage's zero-ranges rule),
      // silently pulling the ENTIRE file into the assistant context. An active range OR
      // a userModified range keeps the file selected.
      const hasActiveSelection = updated.some((range) => range.isActive || range.userModified);
      if (!hasActiveSelection && isKeySelected(explorerStore.getState(), compositeKey)) {
        const { folderId, path } = decodeFileSelection(compositeKey);
        removeSelectedFile(folderId, path);
      }
    },
    [explorerStore, addSelectedFile, removeSelectedFile, setTapestryRangesForKey]
  );

  return useMemo(
    () => ({ chunkState, isFileChecked, toggleChunk, toggleFile }),
    [chunkState, isFileChecked, toggleChunk, toggleFile]
  );
}
