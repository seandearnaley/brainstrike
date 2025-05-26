import type { FileExplorerState } from '@brainstrike/types';
import type { StoreApi, UseBoundStore } from 'zustand';
import {
  cleanupOldFolderStates,
  createNewFolderState,
  saveFolderState,
} from '../utils/file-explorer-utils';

type SetState<T> = UseBoundStore<StoreApi<T>>['setState'];
type GetState<T> = UseBoundStore<StoreApi<T>>['getState'];

export interface FolderStateActions {
  setCurrentFolderId: (folderId: string | null) => void;
  hydrateFolderState: (folderId: string) => void;
}

export const createFolderStateActions = (
  set: SetState<FileExplorerState>,
  get: GetState<FileExplorerState>
): FolderStateActions => ({
  setCurrentFolderId: (folderId: string | null) => {
    const state = get();
    const currentFolderId = state.currentFolderId;

    // If there's no change, do nothing
    if (folderId === currentFolderId) return;

    let updatedFolderStates = { ...state.folderStates };

    // Save current folder state before switching
    if (currentFolderId) {
      updatedFolderStates = saveFolderState(state, currentFolderId);
    }

    // Clean up old folder states before potentially adding a new one
    updatedFolderStates = cleanupOldFolderStates(updatedFolderStates);

    // Restore state for the new folderId or create/reset state
    const newFolderState = updatedFolderStates[folderId as string];

    if (folderId && newFolderState) {
      // Restore existing folder state
      set({
        currentFolderId: folderId,
        folderStates: updatedFolderStates,
        selectedFilePaths: new Set(newFolderState.selectedFilePaths),
        expandedDirectoryPaths: new Set(newFolderState.expandedDirectoryPaths),
        includeFilters: newFolderState.includeFilters,
        excludeFilters: newFolderState.excludeFilters,
        useRegex: newFolderState.useRegex,
        includeProjectTree: newFolderState.includeProjectTree,
        folderSummaryThreshold: newFolderState.folderSummaryThreshold,
        maxSelectionCount: newFolderState.maxSelectionCount,
        lastActiveTab: newFolderState.lastActiveTab ?? 'files',
      });
    } else if (folderId) {
      // Create new folder state
      updatedFolderStates[folderId] = createNewFolderState();

      // If we're switching from null (initial state) to a folder, preserve current selections
      // This prevents losing selections when the folder ID is set for the first time
      const shouldPreserveSelections = currentFolderId === null;

      set({
        currentFolderId: folderId,
        folderStates: updatedFolderStates,
        selectedFilePaths: shouldPreserveSelections ? state.selectedFilePaths : new Set<string>(),
        expandedDirectoryPaths: shouldPreserveSelections
          ? state.expandedDirectoryPaths
          : new Set<string>(),
        // Reset potentially global settings to defaults? Or keep current? Let's keep current for now.
        // includeFilters: DEFAULT_STATE.includeFilters,
        // excludeFilters: DEFAULT_STATE.excludeFilters,
        // useRegex: DEFAULT_STATE.useRegex,
        // includeProjectTree: DEFAULT_STATE.includeProjectTree,
        // folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
        // maxSelectionCount: DEFAULT_STATE.maxSelectionCount, // Keep current max count
        // lastActiveTab: DEFAULT_STATE.lastActiveTab,
      });
    } else {
      // Reset state when no folder is selected (folderId is null)
      set({
        currentFolderId: null,
        folderStates: updatedFolderStates, // Keep cleaned up states
        selectedFilePaths: new Set<string>(),
        expandedDirectoryPaths: new Set<string>(),
        // Optionally reset other fields to default?
      });
    }
  },

  hydrateFolderState: (folderId: string) => {
    set((state) => {
      const folderState = state.folderStates[folderId];
      if (!folderState) return {}; // Return empty object if no changes needed

      return {
        selectedFilePaths: new Set(folderState.selectedFilePaths),
        expandedDirectoryPaths: new Set(folderState.expandedDirectoryPaths),
        includeFilters: folderState.includeFilters,
        excludeFilters: folderState.excludeFilters,
        useRegex: folderState.useRegex,
        includeProjectTree: folderState.includeProjectTree,
        folderSummaryThreshold: folderState.folderSummaryThreshold,
        maxSelectionCount: folderState.maxSelectionCount,
        lastActiveTab: folderState.lastActiveTab ?? 'files',
      };
    });
  },
});
