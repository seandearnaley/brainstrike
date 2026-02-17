import type { FileExplorerState } from '@brainstrike/types';
import {
  MAX_FOLDER_SUMMARY_THRESHOLD,
  MAX_SELECTION_COUNT,
  MAX_TOKEN_BUDGET,
  MIN_FOLDER_SUMMARY_THRESHOLD,
  MIN_MAX_SELECTION_COUNT,
  MIN_TOKEN_BUDGET,
} from '@brainstrike/types';
import type { GetState, SetState } from '../types/store-types';

/**
 * Helper to update both a top-level state property and the matching per-folder state entry.
 * Handles the currentFolderId / folderState guard boilerplate in one place.
 */
function updateWithFolderState(
  state: FileExplorerState,
  updates: Partial<FileExplorerState>
): Partial<FileExplorerState> {
  const { currentFolderId } = state;
  if (!currentFolderId) {
    return updates;
  }

  const folderState = state.folderStates[currentFolderId];
  if (!folderState) {
    return updates;
  }

  return {
    ...updates,
    folderStates: {
      ...state.folderStates,
      [currentFolderId]: {
        ...folderState,
        ...updates,
      },
    },
  };
}

export interface SettingsActions {
  setFilters: (include: readonly string[], exclude: readonly string[]) => void;
  setUseRegex: (useRegex: boolean) => void;
  setIncludeProjectTree: (value: boolean) => void;
  setTokenBudget: (budget: number) => void;
  setFolderSummaryThreshold: (value: number) => void;
  setMaxSelectionCount: (count: number) => void; // Note: Moved from folder-state-actions
  setLastActiveTab: (tab: string) => void; // Note: Moved from folder-state-actions
  setViewFilterPresetId: (presetId: string | null) => void;
  toggleFilterEnabled: (filter: string, type: 'include' | 'exclude') => void;
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
    set((state: FileExplorerState) => updateWithFolderState(state, { tokenBudget: clamped }));
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

  setViewFilterPresetId: (presetId: string | null) => {
    set((state: FileExplorerState) =>
      updateWithFolderState(state, { viewFilterPresetId: presetId })
    );
  },

  toggleFilterEnabled: (filter: string, type: 'include' | 'exclude') => {
    set((state: FileExplorerState) => {
      const targetSet =
        type === 'include' ? state.disabledIncludeFilters : state.disabledExcludeFilters;
      const newSet = new Set(targetSet);

      if (newSet.has(filter)) {
        newSet.delete(filter);
      } else {
        newSet.add(filter);
      }

      return type === 'include'
        ? { disabledIncludeFilters: newSet }
        : { disabledExcludeFilters: newSet };
    });
  },
});
