import type { FileExplorerData, FolderState } from '@brainstrike/types';
import { MAX_FOLDER_STATES } from '@brainstrike/types';

// Helper function to save current folder state
export const saveFolderState = (
  state: FileExplorerData,
  folderId: string,
  now = Date.now()
): Record<string, FolderState> => {
  return {
    ...state.folderStates,
    [folderId]: {
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
    },
  };
};

// Helper function to clean up old folder states
export const cleanupOldFolderStates = (
  folderStates: Record<string, FolderState>
): Record<string, FolderState> => {
  const folderEntries = Object.entries(folderStates);
  if (folderEntries.length >= MAX_FOLDER_STATES) {
    // Sort by lastAccessed (oldest first)
    folderEntries.sort(
      ([, a], [, b]) =>
        ((a as FolderState).lastAccessed || 0) - ((b as FolderState).lastAccessed || 0)
    );

    // Remove oldest entries until we're under the limit
    const entriesToRemove = folderEntries.length - MAX_FOLDER_STATES + 1;
    const newFolderStates = { ...folderStates };

    for (let i = 0; i < entriesToRemove; i++) {
      const [oldestFolderId] = folderEntries[i];
      delete newFolderStates[oldestFolderId];
    }

    return newFolderStates;
  }

  return folderStates;
};

// Helper function to create a new folder state
export const createNewFolderState = (now = Date.now()): FolderState => {
  return {
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
    includeFilters: [],
    excludeFilters: [],
    useRegex: false,
    includeProjectTree: true,
    folderSummaryThreshold: 100,
    maxSelectionCount: 100,
    lastActiveTab: 'files',
    lastAccessed: now,
  };
};
