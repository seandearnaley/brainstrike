export declare function generateReport(selectedFiles: Set<string>, fileContents: {
    [path: string]: string;
}, rootDirectoryHandle: FileSystemDirectoryHandle, includeFilters: string[], excludeFilters: string[], useRegex: boolean, includeProjectTree: boolean, folderSummaryThreshold?: number): Promise<string>;
//# sourceMappingURL=report-generator.d.ts.map