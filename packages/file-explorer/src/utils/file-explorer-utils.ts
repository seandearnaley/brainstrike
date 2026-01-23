import type { FileExplorerData, FolderState } from '@brainstrike/types';
import {
  DEFAULT_FOLDER_SUMMARY_THRESHOLD,
  DEFAULT_MAX_SELECTION_COUNT,
  DEFAULT_TOKEN_BUDGET,
  MAX_FOLDER_STATES,
} from '@brainstrike/types';

// Helper function to save current folder state
export const saveFolderState = (
  state: FileExplorerData,
  folderId: string,
  now = Date.now()
): Record<string, FolderState> => {
  const folderState: FolderState = {
    selectedFilePaths: state.selectedFilePaths,
    expandedDirectoryPaths: state.expandedDirectoryPaths,
    includeFilters: state.includeFilters,
    excludeFilters: state.excludeFilters,
    useRegex: state.useRegex,
    includeProjectTree: state.includeProjectTree,
    tokenBudget: state.tokenBudget,
    folderSummaryThreshold: state.folderSummaryThreshold,
    maxSelectionCount: state.maxSelectionCount,
    lastAccessed: now,
    lastActiveTab: state.lastActiveTab || 'files',
    viewFilterPresetId: state.viewFilterPresetId,
  };

  return {
    ...state.folderStates,
    [folderId]: folderState,
  };
};

// Helper function to clean up old folder states

export const updateFolderAccessOrder = (order: readonly string[], folderId: string): string[] => {
  const newOrder = order.filter((id) => id !== folderId);
  newOrder.push(folderId);
  return newOrder;
};

export const cleanupOldFolderStates = (
  folderStates: Record<string, FolderState>,
  order: readonly string[]
): { folderStates: Record<string, FolderState>; order: string[] } => {
  const newStates = { ...folderStates };
  // Remove any ids from the order array that no longer exist in folderStates
  let newOrder = order.filter((id) => newStates[id]);

  while (newOrder.length > MAX_FOLDER_STATES) {
    const oldestId = newOrder.shift();
    if (oldestId) {
      delete newStates[oldestId];
    }
  }

  // After potentially deleting states due to the max limit, ensure order only
  // contains ids that still exist
  newOrder = newOrder.filter((id) => newStates[id]);

  return { folderStates: newStates, order: newOrder };
};

// Helper function to create a new folder state
export const createNewFolderState = (now = Date.now()): FolderState => ({
  selectedFilePaths: new Set<string>(),
  expandedDirectoryPaths: new Set<string>(),
  includeFilters: [],
  excludeFilters: [],
  useRegex: false,
  includeProjectTree: true,
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  folderSummaryThreshold: DEFAULT_FOLDER_SUMMARY_THRESHOLD,
  maxSelectionCount: DEFAULT_MAX_SELECTION_COUNT,
  lastActiveTab: 'files',
  lastAccessed: now,
  viewFilterPresetId: null,
});
