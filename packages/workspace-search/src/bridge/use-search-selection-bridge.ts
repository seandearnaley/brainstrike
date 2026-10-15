import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from '@brainstrike/file-explorer-ui/shell';
import type { FileExplorerState } from '@brainstrike/types';
import { useCallback, useMemo } from 'react';

/** A search result file is either in the explorer selection or not. */
export type FileSelectionState = 'checked' | 'unchecked';

export interface SearchSelectionBridge {
  fileState: (compositeKey: string) => FileSelectionState;
  toggleFile: (compositeKey: string, nextChecked: boolean) => void;
}

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
 * Bridges workspace-search file checkboxes onto the explorer's selection store,
 * the same store the explorer's own checkboxes drive: a checked result is a
 * selected explorer file, ready for the selection bar's bulk actions.
 */
export function useSearchSelectionBridge(): SearchSelectionBridge {
  const explorerStore = useFileExplorerStoreContext();
  // Subscriptions keep fileState reactive for consumers.
  const selectedFilePaths = useFileExplorerStoreSelector((s) => s.selectedFilePaths);
  const currentFolderId = useFileExplorerStoreSelector((s) => s.currentFolderId);
  const folderStates = useFileExplorerStoreSelector((s) => s.folderStates);
  const addSelectedFile = useFileExplorerStoreSelector((s) => s.addSelectedFile);
  const removeSelectedFile = useFileExplorerStoreSelector((s) => s.removeSelectedFile);

  const fileState = useCallback(
    (compositeKey: string): FileSelectionState =>
      isKeySelected({ currentFolderId, folderStates, selectedFilePaths }, compositeKey)
        ? 'checked'
        : 'unchecked',
    [currentFolderId, folderStates, selectedFilePaths]
  );

  const toggleFile = useCallback(
    (compositeKey: string, nextChecked: boolean): void => {
      if (isKeySelected(explorerStore.getState(), compositeKey) === nextChecked) {
        return;
      }
      const { folderId, path } = decodeFileSelection(compositeKey);
      if (nextChecked) {
        addSelectedFile(folderId, path);
      } else {
        removeSelectedFile(folderId, path);
      }
    },
    [explorerStore, addSelectedFile, removeSelectedFile]
  );

  return useMemo(() => ({ fileState, toggleFile }), [fileState, toggleFile]);
}
