import type { IFileNode } from '../lib/file/types';
import type { LoadingProgressState } from './use-file-tree';
interface UseFileExplorerProps {
    onDisplayedFilePathsChange: (displayedFilePaths: Set<string>) => void;
}
interface UseFileExplorerReturn {
    fileTree: IFileNode[];
    handleRootDirectorySelect: () => Promise<FileSystemDirectoryHandle | null>;
    isLoading: boolean;
    error: Error | null;
    fileContents: {
        [path: string]: string;
    };
    applyFileFilters: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => IFileNode[];
    filterError: string | null;
    rootDirectoryHandle: FileSystemDirectoryHandle | null;
    isFileSystemAccessSupported: () => {
        supported: boolean;
        reason: string;
    };
    loadFileContent: (path: string) => Promise<void>;
    refreshFileExplorer: () => Promise<void>;
    isInitialLoad: boolean;
    clearFileContents: (compositeKeys: string[]) => void;
    loadingProgress: LoadingProgressState | null;
}
export declare function useFileExplorer({ onDisplayedFilePathsChange, }: UseFileExplorerProps): UseFileExplorerReturn;
export {};
//# sourceMappingURL=use-file-explorer.d.ts.map