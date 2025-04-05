/**
 * Folder State Actions
 *
 * This module contains actions for managing folder states in the file explorer.
 * These actions handle folder state persistence, cleanup, and updates.
 */

import { MAX_FOLDER_STATES, MIN_MAX_SELECTION_COUNT } from '../constants/file-explorer-constants';
import type { FileExplorerState, FolderState } from '../types/file-explorer-types';

export const createFolderStateActions = (
  set: (fn: (state: FileExplorerState) => Partial<FileExplorerState>) => void,
  get: () => FileExplorerState
) => ({
  setCurrentFolderId: (folderId: string | null) => {
    set((state) => {
      const now = Date.now();

      // Save current folder state if it exists
      if (state.currentFolderId) {
        const existing = state.folderStates[state.currentFolderId];
        if (existing) {
          existing.lastAccessed = now;
        }
      }

      if (!folderId) {
        return {
          ...state,
          currentFolderId: null,
          selectedFilePaths: new Set(),
          expandedDirectoryPaths: new Set(),
        };
      }

      // Cleanup old folder states if we exceed the maximum
      const folderEntries = Object.entries(state.folderStates);
      if (folderEntries.length >= MAX_FOLDER_STATES) {
        // Sort by lastAccessed (oldest first)
        folderEntries.sort(
          ([, a], [, b]) =>
            ((a as FolderState).lastAccessed || 0) - ((b as FolderState).lastAccessed || 0)
        );
        // Remove oldest entries until we're under the limit
        const entriesToRemove = folderEntries.length - MAX_FOLDER_STATES + 1;
        for (let i = 0; i < entriesToRemove; i++) {
          const [oldestFolderId] = folderEntries[i];
          delete state.folderStates[oldestFolderId];
        }
      }

      const existing = state.folderStates[folderId];
      if (!existing) {
        const newFolderState: FolderState = {
          selectedFilePaths: new Set(state.selectedFilePaths),
          expandedDirectoryPaths: new Set(state.expandedDirectoryPaths),
          includeFilters: [...state.includeFilters],
          excludeFilters: [...state.excludeFilters],
          useRegex: state.useRegex,
          includeProjectTree: state.includeProjectTree,
          folderSummaryThreshold: state.folderSummaryThreshold,
          maxSelectionCount: state.maxSelectionCount,
          lastActiveTab: state.lastActiveTab,
          lastAccessed: now,
        };
        state.folderStates[folderId] = newFolderState;
        return {
          ...state,
          currentFolderId: folderId,
        };
      }

      return {
        ...state,
        currentFolderId: folderId,
        selectedFilePaths: new Set(existing.selectedFilePaths),
        expandedDirectoryPaths: new Set(existing.expandedDirectoryPaths),
      };
    });
  },

  hydrateFolderState: (folderId: string) => {
    const state = get();
    const folderState = state.folderStates[folderId];
    if (!folderState) return;

    set(() => ({
      selectedFilePaths: new Set(folderState.selectedFilePaths),
      expandedDirectoryPaths: new Set(folderState.expandedDirectoryPaths),
      includeFilters: [...folderState.includeFilters],
      excludeFilters: [...folderState.excludeFilters],
      useRegex: folderState.useRegex,
      includeProjectTree: folderState.includeProjectTree,
      folderSummaryThreshold: folderState.folderSummaryThreshold,
      maxSelectionCount: folderState.maxSelectionCount,
      lastActiveTab: folderState.lastActiveTab,
    }));
  },

  setMaxSelectionCount: (count: number) => {
    const state = get();
    const validCount = Math.max(count, MIN_MAX_SELECTION_COUNT);

    if (validCount !== count) {
      console.warn('Max selection count cannot be less than', MIN_MAX_SELECTION_COUNT);
    }

    // If we're reducing the max selection count, we need to remove excess selections
    if (validCount < state.maxSelectionCount && state.selectedFilePaths.size > validCount) {
      const selectedPaths = Array.from(state.selectedFilePaths);
      set(() => ({
        selectedFilePaths: new Set(selectedPaths.slice(0, validCount)),
        maxSelectionCount: validCount,
      }));
    } else {
      set(() => ({ maxSelectionCount: validCount }));
    }
  },

  setLastActiveTab: (tab: string) => {
    set(() => ({ lastActiveTab: tab }));
  },
});
