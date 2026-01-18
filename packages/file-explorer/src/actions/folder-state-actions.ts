import type { FileExplorerState, FolderState } from '@brainstrike/types';
import type { StoreApi, UseBoundStore } from 'zustand';
import {
  cleanupOldFolderStates,
  createNewFolderState,
  saveFolderState,
  updateFolderAccessOrder,
} from '../utils/file-explorer-utils';

type SetState<T> = UseBoundStore<StoreApi<T>>['setState'];
type GetState<T> = UseBoundStore<StoreApi<T>>['getState'];

export interface FolderStateActions {
  setCurrentFolderId: (folderId: string | null) => void;
  hydrateFolderState: (folderId: string) => void;
}

/** Build the state update for restoring an existing folder */
function buildRestoreState(
  folderId: string,
  folderState: FolderState,
  folderStates: Record<string, FolderState>,
  order: string[]
): Partial<FileExplorerState> {
  return {
    currentFolderId: folderId,
    folderStates,
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
}

/** Build the state update for creating a new folder */
function buildNewFolderState(
  folderId: string,
  folderStates: Record<string, FolderState>,
  order: string[]
): Partial<FileExplorerState> {
  return {
    currentFolderId: folderId,
    folderStates,
    folderAccessOrder: order,
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
  };
}

/** Build the state update for resetting (no folder selected) */
function buildResetState(
  folderStates: Record<string, FolderState>,
  order: string[]
): Partial<FileExplorerState> {
  return {
    currentFolderId: null,
    folderStates,
    folderAccessOrder: order,
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
  };
}

/** Prepare folder states by saving current and cleaning up old ones */
function prepareFolderStates(
  state: FileExplorerState,
  currentFolderId: string | null
): { folderStates: Record<string, FolderState>; order: string[] } {
  let updatedFolderStates = { ...state.folderStates };
  let updatedOrder = state.folderAccessOrder;

  if (currentFolderId) {
    updatedFolderStates = saveFolderState(state, currentFolderId);
    updatedOrder = updateFolderAccessOrder(updatedOrder, currentFolderId);
  }

  return cleanupOldFolderStates(updatedFolderStates, updatedOrder);
}

/** Handle restoring an existing folder's state */
function handleRestoreFolder(
  set: SetState<FileExplorerState>,
  folderId: string,
  folderState: FolderState,
  folderStates: Record<string, FolderState>,
  order: string[]
): void {
  const updatedOrder = updateFolderAccessOrder(order, folderId);
  set(buildRestoreState(folderId, folderState, folderStates, updatedOrder));
}

/** Handle creating a new folder state */
function handleCreateNewFolder(
  set: SetState<FileExplorerState>,
  folderId: string,
  folderStates: Record<string, FolderState>,
  order: string[]
): void {
  const updatedFolderStates = { ...folderStates, [folderId]: createNewFolderState() };
  let updatedOrder = updateFolderAccessOrder(order, folderId);
  const cleaned = cleanupOldFolderStates(updatedFolderStates, updatedOrder);
  updatedOrder = cleaned.order;
  set(buildNewFolderState(folderId, cleaned.folderStates, updatedOrder));
}

export const createFolderStateActions = (
  set: SetState<FileExplorerState>,
  get: GetState<FileExplorerState>
): FolderStateActions => ({
  setCurrentFolderId: (folderId: string | null) => {
    const state = get();
    const currentFolderId = state.currentFolderId;

    if (folderId === currentFolderId) {
      return;
    }

    const { folderStates, order } = prepareFolderStates(state, currentFolderId);
    const existingFolderState = folderStates[folderId as string];

    if (folderId && existingFolderState) {
      handleRestoreFolder(set, folderId, existingFolderState, folderStates, order);
    } else if (folderId) {
      handleCreateNewFolder(set, folderId, folderStates, order);
    } else {
      set(buildResetState(folderStates, order));
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
