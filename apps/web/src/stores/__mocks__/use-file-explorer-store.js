import { vi } from 'vitest';
import { create } from 'zustand';
import { DEFAULT_STATE } from '../types/file-explorer-types';
// Create a simple mock implementation that adheres to the FileExplorerState interface
// Use vi.fn() for all actions to allow spying and assertion in tests.
const mockStore = create((set, _get) => ({
    // State - Use defaults or specific mock values
    ...DEFAULT_STATE,
    currentFolderId: null,
    folderStates: {},
    selectedFilePaths: new Set(),
    expandedDirectoryPaths: new Set(),
    // Actions - Mocked with vi.fn()
    setCurrentFolderId: vi.fn((folderId) => set({ currentFolderId: folderId })),
    hydrateFolderState: vi.fn((_folderId) => { }), // Simple mock
    setSelectedFiles: vi.fn((files) => set({ selectedFilePaths: new Set(files) })),
    addSelectedFile: vi.fn((_folderId, filePath) => set((state) => {
        const newSelectedFiles = new Set(state.selectedFilePaths);
        if (newSelectedFiles.size < state.maxSelectionCount) {
            // Respect max count in mock
            newSelectedFiles.add(filePath); // Note: Mock doesn't use composite keys for simplicity here
        }
        return { selectedFilePaths: newSelectedFiles };
    })),
    removeSelectedFile: vi.fn((_folderId, filePath) => set((state) => {
        const newSelectedFiles = new Set(state.selectedFilePaths);
        newSelectedFiles.delete(filePath); // Note: Mock doesn't use composite keys
        return { selectedFilePaths: newSelectedFiles };
    })),
    toggleSelectedFile: vi.fn((_folderId, filePath) => set((state) => {
        const newSelectedFiles = new Set(state.selectedFilePaths);
        if (newSelectedFiles.has(filePath)) {
            newSelectedFiles.delete(filePath);
        }
        else {
            if (newSelectedFiles.size < state.maxSelectionCount) {
                // Respect max count
                newSelectedFiles.add(filePath);
            }
        }
        return { selectedFilePaths: newSelectedFiles };
    })),
    clearSelectedFiles: vi.fn(() => set({ selectedFilePaths: new Set() })),
    setExpandedPaths: vi.fn((paths) => set({ expandedDirectoryPaths: new Set(paths) })),
    toggleDirectoryExpansion: vi.fn((path) => set((state) => {
        const newExpandedPaths = new Set(state.expandedDirectoryPaths);
        if (newExpandedPaths.has(path)) {
            newExpandedPaths.delete(path);
        }
        else {
            newExpandedPaths.add(path);
        }
        return { expandedDirectoryPaths: newExpandedPaths };
    })),
    expandAllDirectories: vi.fn((fileTree) => set((state) => {
        const newExpandedPaths = new Set(state.expandedDirectoryPaths);
        const addDirectoryPaths = (nodes) => {
            for (const node of nodes) {
                if (node.type === 'directory') {
                    newExpandedPaths.add(node.path);
                    if (node.children) {
                        addDirectoryPaths(node.children);
                    }
                }
            }
        };
        addDirectoryPaths(fileTree);
        return { expandedDirectoryPaths: newExpandedPaths };
    })),
    collapseAllDirectories: vi.fn(() => set({ expandedDirectoryPaths: new Set() })),
    setFilters: vi.fn((include, exclude) => set({ includeFilters: [...include], excludeFilters: [...exclude] })),
    setUseRegex: vi.fn((useRegex) => set({ useRegex })),
    setIncludeProjectTree: vi.fn((include) => set({ includeProjectTree: include })),
    setFolderSummaryThreshold: vi.fn((threshold) => set({ folderSummaryThreshold: threshold })),
    setMaxSelectionCount: vi.fn((count) => set({ maxSelectionCount: count })),
    setLastActiveTab: vi.fn((tab) => set({ lastActiveTab: tab })),
}));
// Export the mocked store hook
export const useFileExplorerStore = mockStore;
// Optional: Export the mock functions themselves if needed for direct assertion/spying in tests
export const mockActions = {
    setCurrentFolderId: useFileExplorerStore.getState().setCurrentFolderId,
    hydrateFolderState: useFileExplorerStore.getState().hydrateFolderState,
    setSelectedFiles: useFileExplorerStore.getState().setSelectedFiles,
    addSelectedFile: useFileExplorerStore.getState().addSelectedFile,
    removeSelectedFile: useFileExplorerStore.getState().removeSelectedFile,
    toggleSelectedFile: useFileExplorerStore.getState().toggleSelectedFile,
    clearSelectedFiles: useFileExplorerStore.getState().clearSelectedFiles,
    setExpandedPaths: useFileExplorerStore.getState().setExpandedPaths,
    toggleDirectoryExpansion: useFileExplorerStore.getState().toggleDirectoryExpansion,
    expandAllDirectories: useFileExplorerStore.getState().expandAllDirectories,
    collapseAllDirectories: useFileExplorerStore.getState().collapseAllDirectories,
    setFilters: useFileExplorerStore.getState().setFilters,
    setUseRegex: useFileExplorerStore.getState().setUseRegex,
    setIncludeProjectTree: useFileExplorerStore.getState().setIncludeProjectTree,
    setFolderSummaryThreshold: useFileExplorerStore.getState().setFolderSummaryThreshold,
    setMaxSelectionCount: useFileExplorerStore.getState().setMaxSelectionCount,
    setLastActiveTab: useFileExplorerStore.getState().setLastActiveTab,
};
