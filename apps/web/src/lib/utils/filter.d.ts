import type { FileFilterOptions, IFileNode } from '@/lib/file/types';
/**
 * Utilities for filtering files and directories
 */
export declare const fileFilter: {
    /**
     * Checks if a path should be ignored based on default patterns
     */
    shouldIgnorePath(path: string): boolean;
    /**
     * Matches a string against a wildcard pattern
     */
    matchWildcard(str: string, pattern: string): boolean;
    /**
     * Matches a string against a regex pattern
     */
    matchRegex(str: string, pattern: string): boolean;
    /**
     * Applies filters to a file node
     */
    filterNode(node: IFileNode, { includeFilters, excludeFilters, useRegex }: FileFilterOptions): IFileNode | null;
};
//# sourceMappingURL=filter.d.ts.map