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

export interface SelectionModelActions {
  setSelectionMode: (mode: SelectionMode) => void;
  setSelectionRules: (ruleSetJson: string) => void;
  clearSelectionRules: () => void;
  commitRulesToExplicit: () => void;
  setMaterializedPaths: (paths: Set<string>) => void;
}

export const createSelectionModelActions = (
  set: SetState<FileExplorerState>,
  get: GetState<FileExplorerState>
): SelectionModelActions => ({
  setSelectionMode: (mode: SelectionMode) => {
    const currentState = get();
    const isEnteringRulesMode = mode === 'rules' && currentState.selectionModel.mode !== 'rules';

    set((state: FileExplorerState) => ({
      selectionModel: {
        ...state.selectionModel,
        mode,
      },
      // Clear selectedFilePaths when entering rules mode to avoid stale explicit selections
      // (will be repopulated by setMaterializedPaths when rules are evaluated)
      ...(isEnteringRulesMode ? { selectedFilePaths: new Set<string>() } : {}),
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
    const state = get();
    const { currentFolderId, selectionModel } = state;

    // Only sync to selectedFilePaths when in rules mode
    // This allows all existing components (tree rows, preview, counters) to work
    if (selectionModel.mode === 'rules' && currentFolderId) {
      // Convert relative paths to composite keys for selectedFilePaths compatibility
      const compositeKeys = new Set<string>();
      for (const relativePath of paths) {
        compositeKeys.add(`${currentFolderId}|@|${relativePath}`);
      }

      set({
        selectionModel: {
          ...selectionModel,
          materializedPaths: paths,
          materializedAt: new Date().toISOString(),
        },
        // Sync to selectedFilePaths so all existing components work automatically
        selectedFilePaths: compositeKeys,
      });
    } else {
      // Non-rules mode or no folder ID - just update materialized paths
      set((s: FileExplorerState) => ({
        selectionModel: {
          ...s.selectionModel,
          materializedPaths: paths,
          materializedAt: new Date().toISOString(),
        },
      }));
    }
  },
});
