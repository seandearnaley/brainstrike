import { MAX_FOLDER_STATES } from '../types/file-explorer-types';
// Helper function to save current folder state
export const saveFolderState = (state, folderId, now = Date.now()) => {
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
export const cleanupOldFolderStates = (folderStates) => {
    const folderEntries = Object.entries(folderStates);
    if (folderEntries.length >= MAX_FOLDER_STATES) {
        // Sort by lastAccessed (oldest first)
        folderEntries.sort(([, a], [, b]) => (a.lastAccessed || 0) - (b.lastAccessed || 0));
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
export const createNewFolderState = (now = Date.now()) => {
    return {
        selectedFilePaths: new Set(),
        expandedDirectoryPaths: new Set(),
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
