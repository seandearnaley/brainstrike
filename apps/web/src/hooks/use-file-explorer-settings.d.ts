interface FileExplorerSettings {
    maxSelectionCount: number;
    includeFilters: string[];
    excludeFilters: string[];
    useRegex: boolean;
    includeProjectTree: boolean;
    folderSummaryThreshold: number;
}
export declare function useFileExplorerSettings(): {
    settings: FileExplorerSettings;
    updateSettings: (updates: Partial<FileExplorerSettings>) => void;
};
export {};
//# sourceMappingURL=use-file-explorer-settings.d.ts.map