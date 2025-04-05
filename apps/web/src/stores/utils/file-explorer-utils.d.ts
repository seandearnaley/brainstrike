import type { FileExplorerData, FolderState } from '../types/file-explorer-types';
export declare const saveFolderState: (state: FileExplorerData, folderId: string, now?: number) => Record<string, FolderState>;
export declare const cleanupOldFolderStates: (folderStates: Record<string, FolderState>) => Record<string, FolderState>;
export declare const createNewFolderState: (now?: number) => FolderState;
//# sourceMappingURL=file-explorer-utils.d.ts.map