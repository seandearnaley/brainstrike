interface FileExplorerToolbarProps {
    onDirectorySelect: () => Promise<void>;
    onRefresh: () => Promise<void>;
    onFilterChange: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => void;
    filterError: string | null;
    maxSelectionCount: number;
    quickFilter: string;
    setQuickFilter: (value: string) => void;
    clearQuickFilter: () => void;
    isLoading: boolean;
    isRefreshing: boolean;
    rootDirectoryHandle: FileSystemDirectoryHandle | null;
    onExpandAll: () => void;
    onCollapseAll: () => void;
}
declare const FileExplorerToolbar: React.FC<FileExplorerToolbarProps>;
export { FileExplorerToolbar };
//# sourceMappingURL=file-explorer-toolbar.d.ts.map