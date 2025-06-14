/**
 * Database-first actions for file explorer store
 *
 * These actions manage the database-first mode state including:
 * - Database mode toggle
 * - Folder population status tracking
 * - Population progress monitoring
 */

import type { FileExplorerState } from '@brainstrike/types';
import type { StateCreator } from 'zustand';

export type DatabaseActions = Pick<
  FileExplorerState,
  | 'setDatabaseMode'
  | 'setCurrentFolderPopulated'
  | 'setFolderPopulated'
  | 'setPopulationProgress'
  | 'clearPopulationProgress'
>;

export function createDatabaseActions(
  set: Parameters<StateCreator<FileExplorerState>>[0],
  _get: Parameters<StateCreator<FileExplorerState>>[1]
): DatabaseActions {
  return {
    /**
     * Toggle database-first mode on/off
     */
    setDatabaseMode: (enabled: boolean) => {
      set(() => ({
        databaseMode: enabled,
      }));
    },

    /**
     * Set whether the current folder has been populated in the database
     */
    setCurrentFolderPopulated: (populated: boolean) => {
      set(() => ({
        currentFolderPopulated: populated,
      }));
    },

    /**
     * Set whether a specific folder has been populated in the database
     */
    setFolderPopulated: (folderId: string, populated: boolean) => {
      set((state) => {
        const currentState = state.folderStates[folderId];
        if (!currentState) {
          return state; // Folder doesn't exist yet
        }

        return {
          folderStates: {
            ...state.folderStates,
            [folderId]: {
              ...currentState,
              isPopulated: populated,
              // Clear progress when population is complete
              ...(populated && { populationProgress: undefined }),
            },
          },
          // Update global state if this is the current folder
          ...(state.currentFolderId === folderId && {
            currentFolderPopulated: populated,
          }),
        };
      });
    },

    /**
     * Set folder population progress for UI feedback
     */
    setPopulationProgress: (
      folderId: string,
      progress: { loaded: number; total: number; isLoading: boolean }
    ) => {
      set((state) => {
        const currentState = state.folderStates[folderId];
        if (!currentState) {
          return state; // Folder doesn't exist yet
        }

        return {
          folderStates: {
            ...state.folderStates,
            [folderId]: {
              ...currentState,
              populationProgress: progress,
              // Mark as not populated while loading
              isPopulated: !progress.isLoading,
            },
          },
        };
      });
    },

    /**
     * Clear population progress for a folder
     */
    clearPopulationProgress: (folderId: string) => {
      set((state) => {
        const currentState = state.folderStates[folderId];
        if (!currentState) {
          return state; // Folder doesn't exist yet
        }

        return {
          folderStates: {
            ...state.folderStates,
            [folderId]: {
              ...currentState,
              populationProgress: undefined,
            },
          },
        };
      });
    },
  };
}
