import type { StoreApi, UseBoundStore } from 'zustand';
import type { FileExplorerState } from '../types/file-explorer-types';
type SetState<T> = UseBoundStore<StoreApi<T>>['setState'];
type GetState<T> = UseBoundStore<StoreApi<T>>['getState'];
export interface FileSelectionActions {
    setSelectedFiles: (selectedFiles: ReadonlySet<string>) => void;
    addSelectedFile: (folderId: string, path: string) => void;
    removeSelectedFile: (folderId: string, path: string) => void;
    toggleSelectedFile: (folderId: string, path: string) => void;
    clearSelectedFiles: () => void;
}
export declare const createFileSelectionActions: (set: SetState<FileExplorerState>, _get: GetState<FileExplorerState>) => FileSelectionActions;
export {};
//# sourceMappingURL=file-selection-actions.d.ts.map