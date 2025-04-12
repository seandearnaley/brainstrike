import type { FileExplorerData, FolderState } from '@brainstrike/types';
import { MAX_FOLDER_STATES } from '@brainstrike/types';

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
    folderSummaryThreshold: state.folderSummaryThreshold,
    maxSelectionCount: state.maxSelectionCount,
    lastAccessed: now,
  };

  // Only add lastActiveTab if it exists
  if (state.lastActiveTab !== undefined) {
    folderState.lastActiveTab = state.lastActiveTab;
  }

  return {
    ...state.folderStates,
    [folderId]: folderState,
  };
};

// Helper function to clean up old folder states
export const cleanupOldFolderStates = (
  folderStates: Record<string, FolderState>
): Record<string, FolderState> => {
  const folderEntries = Object.entries(folderStates);
  if (folderEntries.length >= MAX_FOLDER_STATES) {
    // Sort by lastAccessed (oldest first)
    const sortedEntries = [...folderEntries].sort(
      ([, a], [, b]) => (a.lastAccessed || 0) - (b.lastAccessed || 0)
    );

    // Remove oldest entries until we're under the limit
    const entriesToRemove = folderEntries.length - MAX_FOLDER_STATES + 1;
    const newFolderStates = { ...folderStates };

    // Only process entries that exist
    for (let i = 0; i < entriesToRemove && i < sortedEntries.length; i++) {
      const entry = sortedEntries[i];
      if (entry) {
        const [oldestFolderId] = entry;
        delete newFolderStates[oldestFolderId];
      }
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
