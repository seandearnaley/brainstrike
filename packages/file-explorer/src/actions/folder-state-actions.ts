import type { FileExplorerState } from '@brainstrike/types';
import type { StoreApi, UseBoundStore } from 'zustand';
import {
  cleanupOldFolderStates,
  createNewFolderState,
  saveFolderState,
  updateFolderAccessOrder,
} from '../utils/file-explorer-utils';

type SetState<T> = UseBoundStore<StoreApi<T>>['setState'];
type GetState<T> = UseBoundStore<StoreApi<T>>['getState'];

export type FolderStateActions = {
  setCurrentFolderId: (folderId: string | null) => void;
  hydrateFolderState: (folderId: string) => void;
};

export const createFolderStateActions = (
  set: SetState<FileExplorerState>,
  get: GetState<FileExplorerState>
): FolderStateActions => ({
  setCurrentFolderId: (folderId: string | null) => {
    const state = get();
    const currentFolderId = state.currentFolderId;

    // If there's no change, do nothing
    if (folderId === currentFolderId) {
      return;
    }

    let updatedFolderStates = { ...state.folderStates };
    let updatedOrder = state.folderAccessOrder;

    // Save current folder state before switching
    if (currentFolderId) {
      updatedFolderStates = saveFolderState(state, currentFolderId);
      updatedOrder = updateFolderAccessOrder(updatedOrder, currentFolderId);
    }

    // Clean up old folder states before potentially adding a new one
    ({ folderStates: updatedFolderStates, order: updatedOrder } = cleanupOldFolderStates(
      updatedFolderStates,
      updatedOrder
    ));

    // Restore state for the new folderId or create/reset state
    const newFolderState = updatedFolderStates[folderId as string];

    if (folderId && newFolderState) {
      // Restore existing folder state
      updatedOrder = updateFolderAccessOrder(updatedOrder, folderId);
      set({
        currentFolderId: folderId,
        folderStates: updatedFolderStates,
        folderAccessOrder: updatedOrder,
        selectedFilePaths: new Set(newFolderState.selectedFilePaths),
        expandedDirectoryPaths: new Set(newFolderState.expandedDirectoryPaths),
        includeFilters: newFolderState.includeFilters,
        excludeFilters: newFolderState.excludeFilters,
        useRegex: newFolderState.useRegex,
        includeProjectTree: newFolderState.includeProjectTree,
        tokenBudget: newFolderState.tokenBudget,
        folderSummaryThreshold: newFolderState.folderSummaryThreshold,
        maxSelectionCount: newFolderState.maxSelectionCount,
        lastActiveTab: newFolderState.lastActiveTab ?? 'files',
      });
    } else if (folderId) {
      // Create new folder state (resetting current state fields)
      updatedFolderStates[folderId] = createNewFolderState();
      updatedOrder = updateFolderAccessOrder(updatedOrder, folderId);
      ({ folderStates: updatedFolderStates, order: updatedOrder } = cleanupOldFolderStates(
        updatedFolderStates,
        updatedOrder
      ));
      set({
        currentFolderId: folderId,
        folderStates: updatedFolderStates,
        folderAccessOrder: updatedOrder,
        selectedFilePaths: new Set<string>(),
        expandedDirectoryPaths: new Set<string>(),
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
        folderAccessOrder: updatedOrder,
        selectedFilePaths: new Set<string>(),
        expandedDirectoryPaths: new Set<string>(),
        // Optionally reset other fields to default?
      });
    }
  },

  hydrateFolderState: (folderId: string) => {
    set((state) => {
      const folderState = state.folderStates[folderId];
      if (!folderState) {
        return {};
      }

      folderState.lastAccessed = Date.now();
      const order = updateFolderAccessOrder(state.folderAccessOrder, folderId);

      return {
        folderStates: { ...state.folderStates, [folderId]: folderState },
        folderAccessOrder: order,
        selectedFilePaths: new Set(folderState.selectedFilePaths),
        expandedDirectoryPaths: new Set(folderState.expandedDirectoryPaths),
        includeFilters: folderState.includeFilters,
        excludeFilters: folderState.excludeFilters,
        useRegex: folderState.useRegex,
        includeProjectTree: folderState.includeProjectTree,
        tokenBudget: folderState.tokenBudget,
        folderSummaryThreshold: folderState.folderSummaryThreshold,
        maxSelectionCount: folderState.maxSelectionCount,
        lastActiveTab: folderState.lastActiveTab ?? 'files',
      };
    });
  },
});
