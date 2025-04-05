import type { StoreApi, UseBoundStore } from 'zustand';
import type { FileExplorerState } from '../types/file-explorer-types';
type SetState<T> = UseBoundStore<StoreApi<T>>['setState'];
type GetState<T> = UseBoundStore<StoreApi<T>>['getState'];
export interface FolderStateActions {
    setCurrentFolderId: (folderId: string | null) => void;
    hydrateFolderState: (folderId: string) => void;
}
export declare const createFolderStateActions: (set: SetState<FileExplorerState>, get: GetState<FileExplorerState>) => FolderStateActions;
export {};
//# sourceMappingURL=folder-state-actions.d.ts.map