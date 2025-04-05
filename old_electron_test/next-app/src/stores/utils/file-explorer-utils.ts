import type { FileExplorerData, FolderState } from '../types/file-explorer-types';
import { MAX_FOLDER_STATES } from '../types/file-explorer-types';

// Helper function to save current folder state
export const saveFolderState = (state: FileExplorerData, folderId: string, now: number): void => {
  state.folderStates[folderId] = {
    selectedFilePaths: state.selectedFilePaths,
    expandedDirectoryPaths: state.expandedDirectoryPaths,
    includeFilters: state.includeFilters,
    excludeFilters: state.excludeFilters,
    useRegex: state.useRegex,
    includeProjectTree: state.includeProjectTree,
    folderSummaryThreshold: state.folderSummaryThreshold,
    maxSelectionCount: state.maxSelectionCount,
    lastActiveTab: state.lastActiveTab,
    lastAccessed: now,
  };
};

// Helper function to clean up old folder states
export const cleanupOldFolderStates = (state: FileExplorerData): void => {
  const folderEntries = Object.entries(state.folderStates);
  if (folderEntries.length >= MAX_FOLDER_STATES) {
    // Sort by lastAccessed (oldest first)
    folderEntries.sort(
      ([, a], [, b]) =>
        ((a as FolderState).lastAccessed || 0) - ((b as FolderState).lastAccessed || 0)
    );
    // Remove oldest entries until we're under the limit
    const entriesToRemove = folderEntries.length - MAX_FOLDER_STATES + 1;
    for (let i = 0; i < entriesToRemove; i++) {
      const [oldestFolderId] = folderEntries[i];
      delete state.folderStates[oldestFolderId];
    }
  }
};

// Helper function to create a new folder state
export const createNewFolderState = (state: FileExplorerData, now: number): FolderState => {
  return {
    selectedFilePaths: new Set(state.selectedFilePaths),
    expandedDirectoryPaths: new Set(state.expandedDirectoryPaths),
    includeFilters: [...state.includeFilters],
    excludeFilters: [...state.excludeFilters],
    useRegex: state.useRegex,
    includeProjectTree: state.includeProjectTree,
    folderSummaryThreshold: state.folderSummaryThreshold,
    maxSelectionCount: state.maxSelectionCount,
    lastActiveTab: state.lastActiveTab,
    lastAccessed: now,
  };
};
