/**
 * Directory Actions
 *
 * This module contains actions for managing directory expansion state in the file explorer.
 * These actions handle expanding and collapsing directories while maintaining state persistence.
 */
import type { FileExplorerState } from '../types/file-explorer-types';
export declare const createDirectoryActions: (set: (fn: (state: FileExplorerState) => Partial<FileExplorerState>) => void, get: () => FileExplorerState) => {
    setExpandedPaths: (paths: ReadonlySet<string>) => void;
    toggleDirectoryExpansion: (path: string) => void;
};
//# sourceMappingURL=directory-actions.d.ts.map