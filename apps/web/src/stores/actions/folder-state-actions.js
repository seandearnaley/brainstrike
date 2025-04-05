import { cleanupOldFolderStates, createNewFolderState, saveFolderState, } from '../utils/file-explorer-utils';
export const createFolderStateActions = (set, get) => ({
    setCurrentFolderId: (folderId) => {
        const state = get();
        const currentFolderId = state.currentFolderId;
        // If there's no change, do nothing
        if (folderId === currentFolderId)
            return;
        let updatedFolderStates = { ...state.folderStates };
        // Save current folder state before switching
        if (currentFolderId) {
            updatedFolderStates = saveFolderState(state, currentFolderId);
        }
        // Clean up old folder states before potentially adding a new one
        updatedFolderStates = cleanupOldFolderStates(updatedFolderStates);
        // Restore state for the new folderId or create/reset state
        const newFolderState = updatedFolderStates[folderId];
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
                lastActiveTab: newFolderState.lastActiveTab,
            });
        }
        else if (folderId) {
            // Create new folder state (resetting current state fields)
            updatedFolderStates[folderId] = createNewFolderState();
            set({
                currentFolderId: folderId,
                folderStates: updatedFolderStates,
                selectedFilePaths: new Set(),
                expandedDirectoryPaths: new Set(),
                // Reset potentially global settings to defaults? Or keep current? Let's keep current for now.
                // includeFilters: DEFAULT_STATE.includeFilters,
                // excludeFilters: DEFAULT_STATE.excludeFilters,
                // useRegex: DEFAULT_STATE.useRegex,
                // includeProjectTree: DEFAULT_STATE.includeProjectTree,
                // folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
                // maxSelectionCount: DEFAULT_STATE.maxSelectionCount, // Keep current max count
                // lastActiveTab: DEFAULT_STATE.lastActiveTab,
            });
        }
        else {
            // Reset state when no folder is selected (folderId is null)
            set({
                currentFolderId: null,
                folderStates: updatedFolderStates, // Keep cleaned up states
                selectedFilePaths: new Set(),
                expandedDirectoryPaths: new Set(),
                // Optionally reset other fields to default?
            });
        }
    },
    hydrateFolderState: (folderId) => {
        set((state) => {
            const folderState = state.folderStates[folderId];
            if (!folderState)
                return {}; // Return empty object if no changes needed
            return {
                selectedFilePaths: new Set(folderState.selectedFilePaths),
                expandedDirectoryPaths: new Set(folderState.expandedDirectoryPaths),
                includeFilters: folderState.includeFilters,
                excludeFilters: folderState.excludeFilters,
                useRegex: folderState.useRegex,
                includeProjectTree: folderState.includeProjectTree,
                folderSummaryThreshold: folderState.folderSummaryThreshold,
                maxSelectionCount: folderState.maxSelectionCount,
                lastActiveTab: folderState.lastActiveTab,
            };
        });
    },
});
