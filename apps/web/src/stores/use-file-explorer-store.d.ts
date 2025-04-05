/**
 * File Explorer Store
 *
 * This store manages the state of the file explorer, including selected files, expanded directories,
 * and folder-specific states. It uses Zustand with persistence to maintain state across page reloads.
 *
 * Action logic is delegated to separate action creator functions imported from ./actions/*.
 */
import type { FileExplorerState } from './types/file-explorer-types';
export declare const useFileExplorerStore: import("zustand").UseBoundStore<Omit<import("zustand").StoreApi<FileExplorerState>, "persist"> & {
    persist: {
        setOptions: (options: Partial<import("zustand/middleware").PersistOptions<FileExplorerState, import("./types/file-explorer-types").SerializedState>>) => void;
        clearStorage: () => void;
        rehydrate: () => Promise<void> | void;
        hasHydrated: () => boolean;
        onHydrate: (fn: (state: FileExplorerState) => void) => () => void;
        onFinishHydration: (fn: (state: FileExplorerState) => void) => () => void;
        getOptions: () => Partial<import("zustand/middleware").PersistOptions<FileExplorerState, import("./types/file-explorer-types").SerializedState>>;
    };
}>;
//# sourceMappingURL=use-file-explorer-store.d.ts.map