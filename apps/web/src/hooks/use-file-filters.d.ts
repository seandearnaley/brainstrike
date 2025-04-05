import type { IFileNode } from '../lib/file/types';
export declare function useFileFilters(): {
    applyFileFilters: (fileTree: IFileNode[], includeFilters: string[], excludeFilters?: string[], useRegex?: boolean) => IFileNode[];
    filterError: string | null;
};
//# sourceMappingURL=use-file-filters.d.ts.map