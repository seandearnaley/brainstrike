import type { FileExplorerState, FolderState } from '@brainstrike/types';
import {
  MAX_FOLDER_SUMMARY_THRESHOLD,
  MAX_SELECTION_COUNT,
  MAX_TOKEN_BUDGET,
  MIN_FOLDER_SUMMARY_THRESHOLD,
  MIN_MAX_SELECTION_COUNT,
  MIN_TOKEN_BUDGET,
} from '@brainstrike/types';
import type { GetState, SetState } from '../types/store-types';

/** Properties shared between FileExplorerState and FolderState, safe to sync between them. */
type FolderSyncUpdate = Partial<
  Pick<FileExplorerState, Extract<keyof FileExplorerState, keyof FolderState>>
>;

/**
 * Helper to update both a top-level state property and the matching per-folder state entry.
 * Handles the currentFolderId / folderState guard boilerplate in one place.
 *
 * The parameter type constrains updates to properties that exist on both
 * FileExplorerState and FolderState, preventing accidental leakage of
 * top-level-only state (e.g. selectionVersion) into folder entries.
 */
function updateWithFolderState(
  state: FileExplorerState,
  updates: FolderSyncUpdate
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
  setFolderSummaryThreshold: (value: number) => void;
  setIncludeProjectTree: (value: boolean) => void;
  setLastActiveTab: (tab: string) => void; // Note: Moved from folder-state-actions
  setMaxSelectionCount: (count: number) => void; // Note: Moved from folder-state-actions
  setTokenBudget: (budget: number) => void;
  setUseRegex: (useRegex: boolean) => void;
  setViewFilterPresetId: (presetId: string | null) => void;
  toggleFilterEnabled: (filter: string, type: 'include' | 'exclude') => void;
}

export const createSettingsActions = (
  set: SetState<FileExplorerState>,
  _get: GetState<FileExplorerState> // Re-added underscore to satisfy linter, despite usage in callback
): SettingsActions => ({
  setFilters: (include: readonly string[], exclude: readonly string[]) => {
    set((state: FileExplorerState) =>
      updateWithFolderState(state, {
        excludeFilters: [...exclude],
        includeFilters: [...include],
      })
    );
  },

  setFolderSummaryThreshold: (value: number) => {
    set({
      folderSummaryThreshold: Math.max(
        MIN_FOLDER_SUMMARY_THRESHOLD,
        Math.min(value, MAX_FOLDER_SUMMARY_THRESHOLD)
      ),
    });
  },

  setIncludeProjectTree: (value: boolean) => {
    set((state: FileExplorerState) => updateWithFolderState(state, { includeProjectTree: value }));
  },

  setLastActiveTab: (tab: string) => {
    set({ lastActiveTab: tab });
  },

  setMaxSelectionCount: (count: number) => {
    const clampedCount = Math.max(MIN_MAX_SELECTION_COUNT, Math.min(count, MAX_SELECTION_COUNT));
    set((state: FileExplorerState) => {
      let newSelectedFilePaths = state.selectedFilePaths;
      if (clampedCount < state.selectedFilePaths.size) {
        newSelectedFilePaths = new Set(Array.from(state.selectedFilePaths).slice(0, clampedCount));
      }

      // maxSelectionCount is WORKSPACE-GLOBAL: write the value through to
      // EVERY folder snapshot so persisted copies can never diverge again
      // (stale per-folder caps used to silently clamp forest selections).
      // Selection trimming stays scoped to the focused folder — stored
      // foreign selections are only clamped at mutation time.
      const folderStates = Object.fromEntries(
        Object.entries(state.folderStates).map(([id, folderState]) => [
          id,
          {
            ...folderState,
            maxSelectionCount: clampedCount,
            ...(id === state.currentFolderId ? { selectedFilePaths: newSelectedFilePaths } : {}),
          },
        ])
      );

      return {
        folderStates,
        maxSelectionCount: clampedCount,
        selectedFilePaths: newSelectedFilePaths,
      };
    });
  },

  setTokenBudget: (budget: number) => {
    if (!Number.isFinite(budget)) {
      return;
    }

    const normalized = Math.round(budget);
    const clamped = Math.max(MIN_TOKEN_BUDGET, Math.min(normalized, MAX_TOKEN_BUDGET));
    set((state: FileExplorerState) => updateWithFolderState(state, { tokenBudget: clamped }));
  },

  setUseRegex: (useRegex: boolean) => {
    set((state: FileExplorerState) => updateWithFolderState(state, { useRegex }));
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
