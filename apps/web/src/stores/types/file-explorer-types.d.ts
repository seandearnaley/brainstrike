/**
 * File Explorer Types
 *
 * This file contains type definitions for the file explorer store.
 * These types handle both runtime state and serialized state for persistence.
 */
export interface SerializedFolderState {
    selectedFilePaths: string[];
    expandedDirectoryPaths: string[];
    includeFilters: string[];
    excludeFilters: string[];
    useRegex: boolean;
    includeProjectTree: boolean;
    folderSummaryThreshold: number;
    maxSelectionCount: number;
    lastActiveTab?: string;
    lastAccessed: number;
}
export interface SerializedState {
    currentFolderId: string | null;
    folderStates: Record<string, SerializedFolderState>;
    selectedFilePaths: string[];
    expandedDirectoryPaths: string[];
    includeFilters: string[];
    excludeFilters: string[];
    useRegex: boolean;
    includeProjectTree: boolean;
    folderSummaryThreshold: number;
    maxSelectionCount: number;
    lastActiveTab?: string;
}
export interface FolderState {
    selectedFilePaths: Set<string>;
    expandedDirectoryPaths: Set<string>;
    includeFilters: string[];
    excludeFilters: string[];
    useRegex: boolean;
    includeProjectTree: boolean;
    folderSummaryThreshold: number;
    maxSelectionCount: number;
    lastActiveTab?: string;
    lastAccessed: number;
}
export interface FileExplorerData {
    currentFolderId: string | null;
    folderStates: Record<string, FolderState>;
    selectedFilePaths: Set<string>;
    expandedDirectoryPaths: Set<string>;
    includeFilters: string[];
    excludeFilters: string[];
    useRegex: boolean;
    includeProjectTree: boolean;
    folderSummaryThreshold: number;
    maxSelectionCount: number;
    lastActiveTab?: string;
}
export interface FileExplorerState extends FileExplorerData {
    setCurrentFolderId: (folderId: string | null) => void;
    hydrateFolderState: (folderId: string) => void;
    setSelectedFiles: (selectedFiles: ReadonlySet<string>) => void;
    addSelectedFile: (folderId: string, path: string) => void;
    removeSelectedFile: (folderId: string, path: string) => void;
    toggleSelectedFile: (folderId: string, path: string) => void;
    clearSelectedFiles: () => void;
    setExpandedPaths: (paths: ReadonlySet<string>) => void;
    toggleDirectoryExpansion: (path: string) => void;
    setFilters: (include: readonly string[], exclude: readonly string[]) => void;
    setUseRegex: (useRegex: boolean) => void;
    setIncludeProjectTree: (value: boolean) => void;
    setFolderSummaryThreshold: (value: number) => void;
    setMaxSelectionCount: (count: number) => void;
    setLastActiveTab: (tab: string) => void;
    expandAllDirectories: (fileTree: import('@/lib/file/types').IFileNode[]) => void;
    collapseAllDirectories: () => void;
}
export declare const MAX_FOLDER_STATES = 20;
export declare const DEFAULT_STATE: {
    readonly selectedFilePaths: Set<string>;
    readonly expandedDirectoryPaths: Set<string>;
    readonly includeFilters: string[];
    readonly excludeFilters: string[];
    readonly useRegex: false;
    readonly includeProjectTree: true;
    readonly folderSummaryThreshold: 5;
    readonly maxSelectionCount: 100;
    readonly lastActiveTab: undefined;
};
//# sourceMappingURL=file-explorer-types.d.ts.map