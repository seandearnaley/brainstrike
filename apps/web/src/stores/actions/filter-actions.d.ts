/**
 * Filter Actions
 *
 * This module contains actions for managing file filters in the file explorer.
 * These actions handle include/exclude patterns, regex mode, and project tree settings.
 */
import type { FileExplorerState } from '../types/file-explorer-types';
export declare const createFilterActions: (set: (fn: (state: FileExplorerState) => Partial<FileExplorerState>) => void) => {
    setFilters: (include: readonly string[], exclude: readonly string[]) => void;
    setUseRegex: (useRegex: boolean) => void;
    setIncludeProjectTree: (value: boolean) => void;
    setFolderSummaryThreshold: (value: number) => void;
};
//# sourceMappingURL=filter-actions.d.ts.map