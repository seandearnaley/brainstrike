import type { IFileNode } from '../lib/file/types';
export interface LoadingProgressState {
    loaded: number;
    total: number;
    currentPath?: string;
    phase: 'counting' | 'loading';
}
export declare function useFileTree(rootDirectoryHandle: FileSystemDirectoryHandle | null): {
    fileTree: IFileNode[];
    isLoading: boolean;
    error: Error | null;
    refreshTree: () => Promise<void>;
    loadingProgress: LoadingProgressState;
};
//# sourceMappingURL=use-file-tree.d.ts.map