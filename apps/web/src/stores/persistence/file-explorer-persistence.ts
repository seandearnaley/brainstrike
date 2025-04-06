/**
 * File Explorer Persistence
 *
 * This module contains persistence configuration and utilities for the file explorer store.
 * It handles state serialization/deserialization and rehydration.
 */

import type { PersistOptions } from 'zustand/middleware';
import type { FileExplorerState, SerializedState } from '../types/file-explorer-types';
import { DEFAULT_STATE } from '../types/file-explorer-types';

export const createPersistOptions = (): PersistOptions<FileExplorerState, SerializedState> => ({
  name: 'file-explorer-storage',
  version: 3,

  partialize: (state) => {
    console.log('Serializing state:', {
      currentFolderId: state.currentFolderId,
      folderStateKeys: Object.keys(state.folderStates || {}),
      selectedCount: state.selectedFilePaths?.size ?? 0,
    });

    return {
      currentFolderId: state.currentFolderId,
      folderStates: Object.fromEntries(
        Object.entries(state.folderStates || {}).map(([id, folderState]) => [
          id,
          {
            ...folderState,
            selectedFilePaths: Array.from(folderState?.selectedFilePaths || new Set()),
            expandedDirectoryPaths: Array.from(folderState?.expandedDirectoryPaths || new Set()),
            lastAccessed: folderState?.lastAccessed || Date.now(),
          },
        ])
      ),
      selectedFilePaths: Array.from(state.selectedFilePaths || new Set()),
      expandedDirectoryPaths: Array.from(state.expandedDirectoryPaths || new Set()),
      includeFilters: state.includeFilters,
      excludeFilters: state.excludeFilters,
      useRegex: state.useRegex,
      includeProjectTree: state.includeProjectTree,
      folderSummaryThreshold: state.folderSummaryThreshold,
      maxSelectionCount: state.maxSelectionCount,
      lastActiveTab: state.lastActiveTab,
    };
  },

  onRehydrateStorage: () => (persistedState) => {
    console.log('Rehydrating storage, full persisted state:', persistedState);

    // Important: Always provide a complete default state if nothing is persisted
    if (!persistedState) {
      console.log('No persisted state found, returning default state');
      return {
        currentFolderId: null,
        folderStates: {},
        ...DEFAULT_STATE,
      };
    }

    try {
      // If there's no current folder ID, clear selected files
      if (!persistedState.currentFolderId) {
        console.log('No current folder ID, clearing selected files');
        return {
          currentFolderId: null,
          folderStates: {},
          // Use persisted values for user settings if available, otherwise use defaults
          includeFilters: persistedState.includeFilters || DEFAULT_STATE.includeFilters,
          excludeFilters: persistedState.excludeFilters || DEFAULT_STATE.excludeFilters,
          useRegex:
            persistedState.useRegex !== undefined
              ? persistedState.useRegex
              : DEFAULT_STATE.useRegex,
          includeProjectTree:
            persistedState.includeProjectTree !== undefined
              ? persistedState.includeProjectTree
              : DEFAULT_STATE.includeProjectTree,
          folderSummaryThreshold:
            persistedState.folderSummaryThreshold !== undefined
              ? persistedState.folderSummaryThreshold
              : DEFAULT_STATE.folderSummaryThreshold,
          maxSelectionCount: persistedState.maxSelectionCount || DEFAULT_STATE.maxSelectionCount,
          lastActiveTab: persistedState.lastActiveTab,
          selectedFilePaths: new Set<string>(),
          expandedDirectoryPaths: new Set<string>(),
        };
      }

      // Convert arrays back to Sets with type safety
      const folderStates = Object.fromEntries(
        Object.entries(persistedState.folderStates ?? {}).map(([key, folderState]) => [
          key,
          {
            ...folderState,
            selectedFilePaths: new Set(
              Array.isArray(folderState?.selectedFilePaths) ? folderState.selectedFilePaths : []
            ),
            expandedDirectoryPaths: new Set(
              Array.isArray(folderState?.expandedDirectoryPaths)
                ? folderState.expandedDirectoryPaths
                : []
            ),
          },
        ])
      );

      return {
        ...persistedState,
        folderStates,
        selectedFilePaths: new Set(
          Array.isArray(persistedState.selectedFilePaths) ? persistedState.selectedFilePaths : []
        ),
        expandedDirectoryPaths: new Set(
          Array.isArray(persistedState.expandedDirectoryPaths)
            ? persistedState.expandedDirectoryPaths
            : []
        ),
      };
    } catch (error: unknown) {
      console.error('Error rehydrating file explorer state:', error);
      if (error instanceof Error) {
        console.error('Stack trace:', error.stack);
      }
      return {
        currentFolderId: null,
        folderStates: {},
        ...DEFAULT_STATE,
      };
    }
  },
});
