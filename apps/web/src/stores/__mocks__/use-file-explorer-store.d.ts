import type { IFileNode } from '@/lib/file/types';
import type { FileExplorerState } from '../types/file-explorer-types';
export declare const useFileExplorerStore: import("zustand").UseBoundStore<import("zustand").StoreApi<FileExplorerState>>;
export declare const mockActions: {
    setCurrentFolderId: (folderId: string | null) => void;
    hydrateFolderState: (folderId: string) => void;
    setSelectedFiles: (selectedFiles: ReadonlySet<string>) => void;
    addSelectedFile: (folderId: string, path: string) => void;
    removeSelectedFile: (folderId: string, path: string) => void;
    toggleSelectedFile: (folderId: string, path: string) => void;
    clearSelectedFiles: () => void;
    setExpandedPaths: (paths: ReadonlySet<string>) => void;
    toggleDirectoryExpansion: (path: string) => void;
    expandAllDirectories: (fileTree: import("@/lib/file/types").IFileNode[]) => void;
    collapseAllDirectories: () => void;
    setFilters: (include: readonly string[], exclude: readonly string[]) => void;
    setUseRegex: (useRegex: boolean) => void;
    setIncludeProjectTree: (value: boolean) => void;
    setFolderSummaryThreshold: (value: number) => void;
    setMaxSelectionCount: (count: number) => void;
    setLastActiveTab: (tab: string) => void;
};
//# sourceMappingURL=use-file-explorer-store.d.ts.map