import type { StoreApi, UseBoundStore } from 'zustand';
import type { FileExplorerState } from '../types/file-explorer-types';
type SetState<T> = UseBoundStore<StoreApi<T>>['setState'];
type GetState<T> = UseBoundStore<StoreApi<T>>['getState'];
export interface SettingsActions {
    setFilters: (include: readonly string[], exclude: readonly string[]) => void;
    setUseRegex: (useRegex: boolean) => void;
    setIncludeProjectTree: (value: boolean) => void;
    setFolderSummaryThreshold: (value: number) => void;
    setMaxSelectionCount: (count: number) => void;
    setLastActiveTab: (tab: string) => void;
}
export declare const createSettingsActions: (set: SetState<FileExplorerState>, _get: GetState<FileExplorerState>) => SettingsActions;
export {};
//# sourceMappingURL=settings-actions.d.ts.map