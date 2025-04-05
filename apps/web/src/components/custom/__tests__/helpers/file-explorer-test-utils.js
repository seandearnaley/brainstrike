import { vi } from 'vitest';
export const defaultMockStore = {
    selectedFilePaths: new Set(),
    setSelectedFiles: vi.fn(),
    includeFilters: [],
    excludeFilters: [],
    useRegex: false,
    maxSelectionCount: 10,
    setFilters: vi.fn(),
    currentFolderId: null,
    setCurrentFolderId: vi.fn(),
    expandedDirectoryPaths: new Set(),
    toggleDirectoryExpansion: vi.fn(),
    addSelectedFile: vi.fn(),
    removeSelectedFile: vi.fn(),
    clearSelectedFiles: vi.fn(),
};
/**
 * Basic mock for useFileExplorer
 */
export const mockFileExplorer = {
    fileTree: [],
    loadFileContent: vi.fn(),
    fileContents: {},
    error: null,
    isLoading: false,
    isInitialLoad: false,
    rootDirectoryHandle: null,
    handleRootDirectorySelect: vi.fn(),
    isFileSystemAccessSupported: vi.fn(() => ({ supported: true, reason: '' })),
    refreshFileExplorer: vi.fn(),
    applyFileFilters: vi.fn(),
    filterError: null,
    onDisplayedFilePathsChange: vi.fn(),
};
/**
 * Basic mock for useQuickFilter
 */
export const mockQuickFilter = {
    quickFilter: '',
    setQuickFilter: vi.fn(),
    filteredTree: [],
    clearFilter: vi.fn(),
};
/**
 * Basic mock for useFileSystem
 */
export const mockFileSystem = {
    selectRootDirectory: vi.fn(),
    isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
};
/**
 * Basic mock for useFileExplorerSettings
 */
export const mockSettings = {
    settings: {
        maxSelectionCount: 10,
        includeFilters: [],
        excludeFilters: [],
        useRegex: false,
        includeProjectTree: true,
        folderSummaryThreshold: 3,
    },
    updateSettings: vi.fn(),
};
/**
 * Basic mock for useReportGeneration
 */
export const mockReportGeneration = {
    generateReportWithContent: vi.fn().mockResolvedValue('Mock Report Content'),
    isGenerating: false,
};
/**
 * Resets the mock store to default + clears jest mocks
 * so each test starts fresh.
 */
export function resetDefaultMockStore(mockStore) {
    mockStore.selectedFilePaths = new Set();
    mockStore.includeFilters = [];
    mockStore.excludeFilters = [];
    mockStore.useRegex = false;
    mockStore.maxSelectionCount = 10;
    mockStore.currentFolderId = null;
    mockStore.expandedDirectoryPaths = new Set();
}
/**
 * Helper for a directory handle
 */
export function createMockDirectoryHandle() {
    return {
        kind: 'directory',
        name: 'test-root',
    };
}
