interface UseReportGenerationProps {
    selectedFiles: Set<string>;
    fileContents: {
        [path: string]: string;
    };
    rootDirectoryHandle: FileSystemDirectoryHandle | undefined;
    includeFilters: string[];
    excludeFilters: string[];
    useRegex: boolean;
    includeProjectTree: boolean;
    folderSummaryThreshold: number;
}
export declare function useReportGeneration({ selectedFiles, fileContents, rootDirectoryHandle, includeFilters, excludeFilters, useRegex, includeProjectTree, folderSummaryThreshold, }: UseReportGenerationProps): {
    generateReportWithContent: () => Promise<string>;
    isGenerating: boolean;
};
export {};
//# sourceMappingURL=use-report-generation.d.ts.map