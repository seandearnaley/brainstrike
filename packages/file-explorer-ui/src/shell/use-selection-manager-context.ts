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
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { useCallback, useMemo } from 'react';
import { useSelectionResolver } from '../use-selection-resolver';
import { useFileExplorerStoreSelector } from './file-explorer-provider';

export const useSelectionManager = () => {
  const [
    selectedFilePaths,
    maxSelectionCount,
    setSelectedFiles,
    selectionModel,
    currentFolderId,
    clearSelectionRules,
  ] = useFileExplorerStoreSelector(
    (s) =>
      [
        s.selectedFilePaths,
        s.maxSelectionCount,
        s.setSelectedFiles,
        s.selectionModel,
        s.currentFolderId,
        s.clearSelectionRules,
      ] as const
  );
  const {
    effectiveSelection: resolvedSelection,
    isQuerySelectionReady,
    selectedCount: resolvedSelectedCount,
    selectedFilesList: resolvedSelectedFilesList,
  } = useSelectionResolver();

  const setSelectedFilesStable = useCallback(
    (next: ReadonlySet<string>) => {
      setSelectedFiles(new Set(Array.from(next)));
    },
    [setSelectedFiles]
  );

  // Pass stable state view and setter to the core hook
  const core = useCoreSelectionManager({
    selectedFilePaths,
    maxSelectionCount,
    setSelectedFiles: setSelectedFilesStable,
  });

  /**
   * Effective selection based on current mode.
   *
   * In 'explicit' mode: Returns selectedFilePaths (composite keys)
   * In 'rules' mode: Converts materializedPaths to composite keys
   */
  const effectiveSelection = useMemo(() => {
    if (selectionModel.mode === 'query') {
      return resolvedSelection;
    }
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
  }, [
    currentFolderId,
    resolvedSelection,
    selectedFilePaths,
    selectionModel.materializedPaths,
    selectionModel.mode,
  ]);

  // Array façade for UI - uses effective selection
  const selectedFilesList = useMemo(
    () =>
      selectionModel.mode === 'query' ? resolvedSelectedFilesList : Array.from(effectiveSelection),
    [effectiveSelection, resolvedSelectedFilesList, selectionModel.mode]
  );

  const selectedCount = useMemo(() => {
    if (selectionModel.mode === 'query') {
      return resolvedSelectedCount;
    }
    if (selectionModel.mode === 'rules' && selectionModel.materializedPaths) {
      return selectionModel.materializedPaths.size;
    }
    return effectiveSelection.size;
  }, [
    effectiveSelection.size,
    resolvedSelectedCount,
    selectionModel.materializedPaths,
    selectionModel.mode,
  ]);

  const setSelectedFilesFromList = useCallback(
    (list: readonly string[]) => {
      // When clearing all selections (Deselect All) in rules mode,
      // also clear the rules and switch back to explicit mode.
      // This provides intuitive UX: "Deselect All" means "start fresh".
      if (list.length === 0 && selectionModel.mode === 'rules') {
        clearSelectionRules();
        return;
      }
      core.handleSelectionChange(new Set(list));
    },
    [core.handleSelectionChange, selectionModel.mode, clearSelectionRules]
  );

  return {
    ...core,
    selectedFilePaths: effectiveSelection,
    selectedCount,
    selectedFilesList,
    setSelectedFilesFromList,
    /** The effective selection set based on current mode */
    effectiveSelection,
    /** Whether we're in rules mode */
    isRulesMode: selectionModel.mode === 'rules',
    /** Whether we're in query-backed large selection mode */
    isQueryMode: selectionModel.mode === 'query',
    isQuerySelectionReady,
  };
};
