import type { TapestryRange } from '@brainstrike/file-explorer-ui';
import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/preview';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from '@brainstrike/file-explorer-ui/shell';
import type { FileExplorerState } from '@brainstrike/types';
import { decodeFileSelection } from '@brainstrike/utils/selection-utils';
import { useCallback, useMemo } from 'react';
import { type SelectedChunk, useChunkSelectionStore } from './chunk-selection-store';
import { deriveSearchRanges, searchRangeColor } from './range-math';

/** File checkbox is the ONLY tri-state: whole-file, chunk-subset, or none. */
export type FileSelectionState = 'checked' | 'indeterminate' | 'unchecked';
/** Chunk checkboxes are strictly binary — a chunk is either in context or not. */
export type ChunkSelectionState = 'checked' | 'unchecked';

export interface SearchSelectionBridge {
  chunkState: (compositeKey: string, chunkId: string) => ChunkSelectionState;
  fileState: (compositeKey: string) => FileSelectionState;
  /**
   * Toggle a chunk. `siblingResultChunks` is the file's FULL result-chunk list
   * from the tree — needed to CONVERT a whole-file selection into "everything
   * except this chunk" when the user unchecks one chunk of a whole-file doc.
   */
  toggleChunk: (
    compositeKey: string,
    chunk: SelectedChunk,
    nextChecked: boolean,
    siblingResultChunks: readonly SelectedChunk[]
  ) => void;
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

function subsetForKey(compositeKey: string): Record<string, SelectedChunk> {
  return useChunkSelectionStore.getState().selectionsByKey[compositeKey] ?? {};
}

/**
 * Bridges workspace-search checkboxes onto the SAME two stores the file-explorer's
 * own checkboxes drive: file membership -> the file-explorer selection store,
 * chunk selection -> the session chunk-selection SET (source of truth).
 *
 * The selected-chunk set is authoritative; the workspace-context curation
 * (tapestry) ranges are a ONE-WAY derived OUTPUT re-emitted after every set
 * mutation. Because ranges are output-only, deriving them by MERGING overlapping
 * spans is now safe — checkbox state never reads them back.
 *
 * INVARIANT (no silent data loss): search mutates ONLY its own `origin:'search'`
 * ranges; every range with a different origin (userModified hand-drags or any
 * other origin) is preserved verbatim on every write. Absence of ranges = whole
 * file — an emptied search set writes no `[]` residue (the store deletes the key).
 */
export function useSearchSelectionBridge(): SearchSelectionBridge {
  const explorerStore = useFileExplorerStoreContext();
  // Subscriptions keep fileState/chunkState reactive for consumers.
  const selectedFilePaths = useFileExplorerStoreSelector((s) => s.selectedFilePaths);
  const currentFolderId = useFileExplorerStoreSelector((s) => s.currentFolderId);
  const folderStates = useFileExplorerStoreSelector((s) => s.folderStates);
  const addSelectedFile = useFileExplorerStoreSelector((s) => s.addSelectedFile);
  const removeSelectedFile = useFileExplorerStoreSelector((s) => s.removeSelectedFile);
  const selectionsByKey = useChunkSelectionStore((s) => s.selectionsByKey);
  const addChunk = useChunkSelectionStore((s) => s.addChunk);
  const removeChunk = useChunkSelectionStore((s) => s.removeChunk);
  const replaceForKey = useChunkSelectionStore((s) => s.replaceForKey);
  const clearForKey = useChunkSelectionStore((s) => s.clearForKey);
  const setTapestryRangesForKey = useWorkspaceContextCurationStore(
    (s) => s.setTapestryRangesForKey
  );

  const selectFile = useCallback(
    (compositeKey: string): void => {
      if (!isKeySelected(explorerStore.getState(), compositeKey)) {
        const { folderId, path } = decodeFileSelection(compositeKey);
        addSelectedFile(folderId, path);
      }
    },
    [explorerStore, addSelectedFile]
  );

  const deselectFile = useCallback(
    (compositeKey: string): void => {
      if (isKeySelected(explorerStore.getState(), compositeKey)) {
        const { folderId, path } = decodeFileSelection(compositeKey);
        removeSelectedFile(folderId, path);
      }
    },
    [explorerStore, removeSelectedFile]
  );

  /**
   * Re-derive the search-owned ranges for a key from the LATEST chunk set and
   * write them alongside the preserved non-search ranges (set first, ranges
   * second). Search never mutates a range whose origin is not 'search'.
   */
  const writeRangesForKey = useCallback(
    (compositeKey: string): void => {
      const chunks = Object.values(subsetForKey(compositeKey));
      const existing =
        useWorkspaceContextCurationStore.getState().tapestryRangesByKey[compositeKey] ?? [];
      const preserved = existing.filter((range: TapestryRange) => range.origin !== 'search');
      setTapestryRangesForKey(compositeKey, [
        ...deriveSearchRanges(chunks, makeId, searchRangeColor),
        ...preserved,
      ]);
    },
    [setTapestryRangesForKey]
  );

  const fileState = useCallback(
    (compositeKey: string): FileSelectionState => {
      const hasSubset = Object.keys(selectionsByKey[compositeKey] ?? {}).length > 0;
      if (hasSubset) {
        return 'indeterminate';
      }
      return isKeySelected({ currentFolderId, folderStates, selectedFilePaths }, compositeKey)
        ? 'checked'
        : 'unchecked';
    },
    [currentFolderId, folderStates, selectedFilePaths, selectionsByKey]
  );

  const chunkState = useCallback(
    (compositeKey: string, chunkId: string): ChunkSelectionState => {
      const subset = selectionsByKey[compositeKey] ?? {};
      if (subset[chunkId] !== undefined) {
        return 'checked';
      }
      // Whole-file selection (empty subset + file selected) genuinely includes
      // every chunk's content.
      const hasSubset = Object.keys(subset).length > 0;
      if (
        !hasSubset &&
        isKeySelected({ currentFolderId, folderStates, selectedFilePaths }, compositeKey)
      ) {
        return 'checked';
      }
      return 'unchecked';
    },
    [currentFolderId, folderStates, selectedFilePaths, selectionsByKey]
  );

  const toggleFile = useCallback(
    (compositeKey: string, nextChecked: boolean): void => {
      // Whole-file supersedes any chunk subset: clear the set either way so the
      // derived search ranges collapse to empty. With no search ranges left, the
      // store deletes the key (absence = whole file when selected; nothing at all
      // when deselected). Non-search origins are still preserved by writeRangesForKey.
      clearForKey(compositeKey);
      if (nextChecked) {
        selectFile(compositeKey);
      } else {
        deselectFile(compositeKey);
      }
      writeRangesForKey(compositeKey);
    },
    [clearForKey, selectFile, deselectFile, writeRangesForKey]
  );

  const toggleChunk = useCallback(
    (
      compositeKey: string,
      chunk: SelectedChunk,
      nextChecked: boolean,
      siblingResultChunks: readonly SelectedChunk[]
    ): void => {
      const subset = subsetForKey(compositeKey);
      const inSet = subset[chunk.chunkId] !== undefined;
      const hasSubset = Object.keys(subset).length > 0;
      const fileSelected = isKeySelected(explorerStore.getState(), compositeKey);

      if (nextChecked) {
        if (inSet) {
          return;
        }
        addChunk(compositeKey, chunk);
        selectFile(compositeKey);
        writeRangesForKey(compositeKey);
        return;
      }

      // Unchecking a chunk that is in the set: drop it. If the subset empties,
      // deselect the file too (no zero-subset selected file lingering).
      if (inSet) {
        removeChunk(compositeKey, chunk.chunkId);
        if (Object.keys(subsetForKey(compositeKey)).length === 0) {
          deselectFile(compositeKey);
        }
        writeRangesForKey(compositeKey);
        return;
      }

      // Unchecking a chunk NOT in the set but under a WHOLE-FILE selection:
      // CONVERT to "every sibling result chunk except this one". The file stays
      // selected (now indeterminate); if nothing remains, deselect it.
      if (fileSelected && !hasSubset) {
        const remainder = siblingResultChunks.filter((c) => c.chunkId !== chunk.chunkId);
        if (remainder.length === 0) {
          clearForKey(compositeKey);
          deselectFile(compositeKey);
        } else {
          replaceForKey(compositeKey, remainder);
        }
        writeRangesForKey(compositeKey);
      }
      // Else: already unchecked and not whole-file — nothing to do.
    },
    [
      explorerStore,
      addChunk,
      removeChunk,
      replaceForKey,
      clearForKey,
      selectFile,
      deselectFile,
      writeRangesForKey,
    ]
  );

  return useMemo(
    () => ({ chunkState, fileState, toggleChunk, toggleFile }),
    [chunkState, fileState, toggleChunk, toggleFile]
  );
}
