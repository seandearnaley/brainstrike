import type { StoreApi, UseBoundStore } from 'zustand';
import type { IFileNode } from '../../lib/file/types';
import type { FileExplorerState } from '../types/file-explorer-types';
type SetState<T> = UseBoundStore<StoreApi<T>>['setState'];
type GetState<T> = UseBoundStore<StoreApi<T>>['getState'];
export interface DirectoryExpansionActions {
    setExpandedPaths: (paths: ReadonlySet<string>) => void;
    toggleDirectoryExpansion: (path: string) => void;
    expandAllDirectories: (fileTree: IFileNode[]) => void;
    collapseAllDirectories: () => void;
}
export declare const createDirectoryExpansionActions: (set: SetState<FileExplorerState>, _get: GetState<FileExplorerState>) => DirectoryExpansionActions;
export {};
//# sourceMappingURL=directory-expansion-actions.d.ts.map