import type { IFileNode } from '@/lib/file/types';
import type { Mock } from 'vitest';
/**
 * Mock store interface
 * Typical usage: replicate Zustand store shape for useFileExplorerStore.
 */
interface MockStore {
    selectedFilePaths: Set<string>;
    setSelectedFiles: Mock;
    includeFilters: string[];
    excludeFilters: string[];
    useRegex: boolean;
    maxSelectionCount: number;
    setFilters: Mock;
    currentFolderId: string | null;
    setCurrentFolderId: Mock;
    expandedDirectoryPaths: Set<string>;
    toggleDirectoryExpansion: Mock;
    addSelectedFile: Mock;
    removeSelectedFile: Mock;
    clearSelectedFiles: Mock;
}
export declare const defaultMockStore: MockStore;
/**
 * Basic mock for useFileExplorer
 */
export declare const mockFileExplorer: {
    fileTree: IFileNode[];
    loadFileContent: Mock<(...args: any[]) => any>;
    fileContents: Record<string, string>;
    error: Error | null;
    isLoading: boolean;
    isInitialLoad: boolean;
    rootDirectoryHandle: FileSystemDirectoryHandle | null;
    handleRootDirectorySelect: Mock<(...args: any[]) => any>;
    isFileSystemAccessSupported: Mock<() => {
        supported: boolean;
        reason: string;
    }>;
    refreshFileExplorer: Mock<(...args: any[]) => any>;
    applyFileFilters: Mock<(...args: any[]) => any>;
    filterError: string | null;
    onDisplayedFilePathsChange: Mock<(...args: any[]) => any>;
};
/**
 * Basic mock for useQuickFilter
 */
export declare const mockQuickFilter: {
    quickFilter: string;
    setQuickFilter: Mock<(...args: any[]) => any>;
    filteredTree: IFileNode[];
    clearFilter: Mock<(...args: any[]) => any>;
};
/**
 * Basic mock for useFileSystem
 */
export declare const mockFileSystem: {
    selectRootDirectory: Mock<(...args: any[]) => any>;
    isFileSystemAccessSupported: () => {
        supported: boolean;
        reason: string;
    };
};
/**
 * Basic mock for useFileExplorerSettings
 */
export declare const mockSettings: {
    settings: {
        maxSelectionCount: number;
        includeFilters: never[];
        excludeFilters: never[];
        useRegex: boolean;
        includeProjectTree: boolean;
        folderSummaryThreshold: number;
    };
    updateSettings: Mock<(...args: any[]) => any>;
};
/**
 * Basic mock for useReportGeneration
 */
export declare const mockReportGeneration: {
    generateReportWithContent: Mock<(...args: any[]) => any>;
    isGenerating: boolean;
};
/**
 * Resets the mock store to default + clears jest mocks
 * so each test starts fresh.
 */
export declare function resetDefaultMockStore(mockStore: MockStore): void;
/**
 * Helper for a directory handle
 */
export declare function createMockDirectoryHandle(): FileSystemDirectoryHandle;
export {};
//# sourceMappingURL=file-explorer-test-utils.d.ts.map