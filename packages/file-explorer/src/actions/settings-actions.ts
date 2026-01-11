import type { FileExplorerState } from '@brainstrike/types';
import {
  MAX_FOLDER_SUMMARY_THRESHOLD,
  MAX_SELECTION_COUNT,
  MAX_TOKEN_BUDGET,
  MIN_FOLDER_SUMMARY_THRESHOLD,
  MIN_MAX_SELECTION_COUNT,
  MIN_TOKEN_BUDGET,
} from '@brainstrike/types';
import type { StoreApi, UseBoundStore } from 'zustand';

type SetState<T> = UseBoundStore<StoreApi<T>>['setState'];
type GetState<T> = UseBoundStore<StoreApi<T>>['getState'];

export interface SettingsActions {
  setFilters: (include: readonly string[], exclude: readonly string[]) => void;
  setUseRegex: (useRegex: boolean) => void;
  setIncludeProjectTree: (value: boolean) => void;
  setTokenBudget: (budget: number) => void;
  setFolderSummaryThreshold: (value: number) => void;
  setMaxSelectionCount: (count: number) => void; // Note: Moved from folder-state-actions
  setLastActiveTab: (tab: string) => void; // Note: Moved from folder-state-actions
}

export const createSettingsActions = (
  set: SetState<FileExplorerState>,
  _get: GetState<FileExplorerState> // Re-added underscore to satisfy linter, despite usage in callback
): SettingsActions => ({
  setFilters: (include: readonly string[], exclude: readonly string[]) => {
    set({ includeFilters: [...include], excludeFilters: [...exclude] });
  },

  setUseRegex: (useRegex: boolean) => {
    set({ useRegex });
  },

  setIncludeProjectTree: (value: boolean) => {
    set({ includeProjectTree: value });
  },

  setTokenBudget: (budget: number) => {
    if (!Number.isFinite(budget)) {
      return;
    }

    const normalized = Math.round(budget);
    const clamped = Math.max(MIN_TOKEN_BUDGET, Math.min(normalized, MAX_TOKEN_BUDGET));
    set((state: FileExplorerState) => {
      const currentFolderId = state.currentFolderId;
      if (!currentFolderId) {
        return { tokenBudget: clamped };
      }

      const folderState = state.folderStates[currentFolderId];
      if (!folderState) {
        return { tokenBudget: clamped };
      }

      return {
        tokenBudget: clamped,
        folderStates: {
          ...state.folderStates,
          [currentFolderId]: {
            ...folderState,
            tokenBudget: clamped,
          },
        },
      };
    });
  },

  setFolderSummaryThreshold: (value: number) => {
    set({
      folderSummaryThreshold: Math.max(
        MIN_FOLDER_SUMMARY_THRESHOLD,
        Math.min(value, MAX_FOLDER_SUMMARY_THRESHOLD)
      ),
    });
  },

  setMaxSelectionCount: (count: number) => {
    const clampedCount = Math.max(MIN_MAX_SELECTION_COUNT, Math.min(count, MAX_SELECTION_COUNT));
    set((state: FileExplorerState) => {
      // Added explicit type for state
      let newSelectedFilePaths = state.selectedFilePaths;
      // If reducing the count, trim excess selected files
      if (clampedCount < state.selectedFilePaths.size) {
        newSelectedFilePaths = new Set(Array.from(state.selectedFilePaths).slice(0, clampedCount));
      }
      return {
        maxSelectionCount: clampedCount,
        selectedFilePaths: newSelectedFilePaths,
      };
    });
  },

  setLastActiveTab: (tab: string) => {
    set({ lastActiveTab: tab });
  },
});
