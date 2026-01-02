/**
 * Selection Manager Hook (Context-aware)
 *
 * This hook manages file selection state and enforces selection limits.
 * It uses the context-based store instead of the global store.
 *
 * Supports two selection modes:
 * - 'explicit': Traditional manual file selection
 * - 'rules': Rule-based selection using materialized paths
 */

import { useSelectionManager as useCoreSelectionManager } from '@brainstrike/file-explorer-hooks';
import { encodeFileSelection } from '@brainstrike/utils';
import { useCallback, useMemo } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';

type UseSelectionManagerProps = {
  onSelectionLimitExceeded: () => void;
};

export const useSelectionManager = ({ onSelectionLimitExceeded }: UseSelectionManagerProps) => {
  const store = useFileExplorerStoreContext();
  const [selectedFilePaths, maxSelectionCount, setSelectedFiles, selectionModel, currentFolderId] =
    store(
      (s) =>
        [
          s.selectedFilePaths,
          s.maxSelectionCount,
          s.setSelectedFiles,
          s.selectionModel,
          s.currentFolderId,
        ] as const
    );

  const setSelectedFilesStable = useCallback(
    (next: ReadonlySet<string>) => {
      const array = next instanceof Set ? Array.from(next) : Array.from(next);
      setSelectedFiles(new Set(array));
    },
    [setSelectedFiles]
  );

  // Pass stable state view and setter to the core hook
  const core = useCoreSelectionManager({
    selectedFilePaths,
    maxSelectionCount,
    setSelectedFiles: setSelectedFilesStable,
    onSelectionLimitExceeded,
  });

  /**
   * Effective selection based on current mode.
   *
   * In 'explicit' mode: Returns selectedFilePaths (composite keys)
   * In 'rules' mode: Converts materializedPaths to composite keys
   */
  const effectiveSelection = useMemo(() => {
    if (selectionModel.mode === 'rules' && selectionModel.materializedPaths && currentFolderId) {
      // Convert materialized paths (relative) to composite keys
      const compositeKeys = new Set<string>();
      for (const relativePath of selectionModel.materializedPaths) {
        compositeKeys.add(encodeFileSelection(currentFolderId, relativePath));
      }
      return compositeKeys;
    }
    // Default to explicit selection
    return selectedFilePaths;
  }, [selectionModel.mode, selectionModel.materializedPaths, currentFolderId, selectedFilePaths]);

  // Array façade for UI - uses effective selection
  const selectedFilesList = useMemo(() => Array.from(effectiveSelection), [effectiveSelection]);

  const setSelectedFilesFromList = useCallback(
    (list: readonly string[]) => core.handleSelectionChange(new Set(list)),
    [core.handleSelectionChange]
  );

  return {
    ...core,
    selectedFilesList,
    setSelectedFilesFromList,
    /** The effective selection set based on current mode */
    effectiveSelection,
    /** Whether we're in rules mode */
    isRulesMode: selectionModel.mode === 'rules',
  };
};
