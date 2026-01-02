/**
 * Selection Model Actions
 *
 * Actions for managing the selection model which supports both explicit
 * path-based selection and rule-based selection modes.
 */

import type { FileExplorerState, SelectionMode } from '@brainstrike/types';
import type { StoreApi, UseBoundStore } from 'zustand';

type SetState<T> = UseBoundStore<StoreApi<T>>['setState'];
type GetState<T> = UseBoundStore<StoreApi<T>>['getState'];

export type SelectionModelActions = {
  setSelectionMode: (mode: SelectionMode) => void;
  setSelectionRules: (ruleSetJson: string) => void;
  clearSelectionRules: () => void;
  commitRulesToExplicit: () => void;
  setMaterializedPaths: (paths: Set<string>) => void;
};

export const createSelectionModelActions = (
  set: SetState<FileExplorerState>,
  get: GetState<FileExplorerState>
): SelectionModelActions => ({
  setSelectionMode: (mode: SelectionMode) => {
    set((state: FileExplorerState) => ({
      selectionModel: {
        ...state.selectionModel,
        mode,
      },
    }));
  },

  setSelectionRules: (ruleSetJson: string) => {
    set((state: FileExplorerState) => ({
      selectionModel: {
        ...state.selectionModel,
        ruleSetJson,
        // Clear materialized cache when rules change
        materializedPaths: null,
        materializedAt: null,
      },
    }));
  },

  clearSelectionRules: () => {
    set((state: FileExplorerState) => ({
      selectionModel: {
        ...state.selectionModel,
        mode: 'explicit',
        ruleSetJson: null,
        materializedPaths: null,
        materializedAt: null,
      },
    }));
  },

  commitRulesToExplicit: () => {
    const state = get();
    const { selectionModel, currentFolderId } = state;

    // Only commit if in rules mode with materialized paths
    if (selectionModel.mode !== 'rules' || !selectionModel.materializedPaths) {
      return;
    }

    // Convert materialized relative paths to composite keys if we have a folder ID
    const explicitPaths = new Set<string>();
    for (const relativePath of selectionModel.materializedPaths) {
      if (currentFolderId) {
        // Create composite key: folderId|@|path
        explicitPaths.add(`${currentFolderId}|@|${relativePath}`);
      } else {
        // If no folder ID, use path directly (legacy behavior)
        explicitPaths.add(relativePath);
      }
    }

    set({
      selectionModel: {
        mode: 'explicit',
        explicitPaths,
        ruleSetJson: null,
        materializedPaths: null,
        materializedAt: null,
      },
      // Also update the legacy selectedFilePaths for backward compatibility
      selectedFilePaths: explicitPaths,
    });
  },

  setMaterializedPaths: (paths: Set<string>) => {
    set((state: FileExplorerState) => ({
      selectionModel: {
        ...state.selectionModel,
        materializedPaths: paths,
        materializedAt: new Date().toISOString(),
      },
    }));
  },
});
