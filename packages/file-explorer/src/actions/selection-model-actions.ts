/**
 * Selection Model Actions
 *
 * Actions for managing the selection model which supports both explicit
 * path-based selection and rule-based selection modes.
 */

import type {
  FileExplorerState,
  QuerySelectionManifest,
  SelectionMode,
  SelectionQueryDescriptor,
} from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import type { GetState, SetState } from '../types/store-types';

function manifestsEqual(
  left: QuerySelectionManifest | null,
  right: QuerySelectionManifest | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!(left && right)) {
    return false;
  }
  if (
    left.status !== right.status ||
    left.fingerprint !== right.fingerprint ||
    left.snapshotId !== right.snapshotId ||
    left.errorMessage !== right.errorMessage ||
    left.filePaths.length !== right.filePaths.length
  ) {
    return false;
  }
  for (let index = 0; index < left.filePaths.length; index += 1) {
    if (left.filePaths[index] !== right.filePaths[index]) {
      return false;
    }
  }
  return true;
}

export interface SelectionModelActions {
  clearSelectionRules: () => void;
  commitRulesToExplicit: () => void;
  setMaterializedPaths: (paths: Set<string>) => void;
  setQuerySelection: (
    descriptor: SelectionQueryDescriptor,
    manifest: QuerySelectionManifest,
    materializedPaths?: Set<string>
  ) => void;
  setQuerySelectionManifest: (manifest: QuerySelectionManifest | null) => void;
  setSelectionMode: (mode: SelectionMode) => void;
  setSelectionRules: (ruleSetJson: string) => void;
}

export const createSelectionModelActions = (
  set: SetState<FileExplorerState>,
  get: GetState<FileExplorerState>
): SelectionModelActions => ({
  clearSelectionRules: () => {
    set((state: FileExplorerState) => ({
      querySelectionManifest: null,
      selectionModel: {
        ...state.selectionModel,
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit',
        queryDescriptor: null,
        ruleSetJson: null,
      },
      selectionVersion: state.selectionVersion + 1,
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
        explicitPaths.add(encodeFileSelection(currentFolderId, relativePath));
      } else {
        // If no folder ID, use path directly (legacy behavior)
        explicitPaths.add(relativePath);
      }
    }

    set({
      querySelectionManifest: null,
      // Also update the legacy selectedFilePaths for backward compatibility
      selectedFilePaths: explicitPaths,
      selectionModel: {
        explicitPaths,
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit',
        queryDescriptor: null,
        ruleSetJson: null,
      },
      selectionVersion: state.selectionVersion + 1,
    });
  },

  setMaterializedPaths: (paths: Set<string>) => {
    const state = get();
    const { currentFolderId, selectionModel } = state;

    // Only sync to selectedFilePaths when in rules mode.
    if (selectionModel.mode === 'rules' && currentFolderId) {
      // Convert relative paths to composite keys for selectedFilePaths compatibility
      const compositeKeys = new Set<string>();
      for (const relativePath of paths) {
        compositeKeys.add(encodeFileSelection(currentFolderId, relativePath));
      }

      set({
        // Sync to selectedFilePaths so all existing components work automatically
        selectedFilePaths: compositeKeys,
        selectionModel: {
          ...selectionModel,
          materializedAt: new Date().toISOString(),
          materializedPaths: paths,
        },
        selectionVersion: state.selectionVersion + 1,
      });
    } else {
      // Non-rules mode or no folder ID - just update materialized paths
      set((s: FileExplorerState) => ({
        selectionModel: {
          ...s.selectionModel,
          materializedAt: new Date().toISOString(),
          materializedPaths: paths,
        },
        selectionVersion: s.selectionVersion + 1,
      }));
    }
  },

  setQuerySelection: (
    descriptor: SelectionQueryDescriptor,
    manifest: QuerySelectionManifest,
    materializedPaths?: Set<string>
  ) => {
    set((state: FileExplorerState) => ({
      querySelectionManifest: manifest,
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: new Date().toISOString(),
        materializedPaths: materializedPaths ?? null,
        mode: 'query',
        queryDescriptor: descriptor,
        ruleSetJson: null,
      },
      selectionVersion: state.selectionVersion + 1,
    }));
  },

  setQuerySelectionManifest: (manifest: QuerySelectionManifest | null) => {
    set((state: FileExplorerState) => {
      const manifestFingerprint =
        manifest?.fingerprint ?? state.selectionModel.queryDescriptor?.manifestFingerprint ?? null;
      const manifestSnapshotId =
        manifest?.snapshotId ?? state.selectionModel.queryDescriptor?.manifestSnapshotId ?? null;
      const queryDescriptorUnchanged =
        state.selectionModel.mode !== 'query' ||
        !state.selectionModel.queryDescriptor ||
        (state.selectionModel.queryDescriptor.manifestFingerprint === manifestFingerprint &&
          state.selectionModel.queryDescriptor.manifestSnapshotId === manifestSnapshotId);

      if (manifestsEqual(state.querySelectionManifest, manifest) && queryDescriptorUnchanged) {
        return {};
      }

      const nextSelectionModel =
        state.selectionModel.mode === 'query' && state.selectionModel.queryDescriptor
          ? {
              ...state.selectionModel,
              queryDescriptor: {
                ...state.selectionModel.queryDescriptor,
                manifestFingerprint,
                manifestSnapshotId,
              },
            }
          : state.selectionModel;

      return {
        querySelectionManifest: manifest,
        selectionModel: nextSelectionModel,
      };
    });
  },
  setSelectionMode: (mode: SelectionMode) => {
    const currentState = get();
    const isEnteringRulesMode = mode === 'rules' && currentState.selectionModel.mode !== 'rules';
    const isEnteringQueryMode = mode === 'query' && currentState.selectionModel.mode !== 'query';

    set((state: FileExplorerState) => ({
      selectionModel: {
        ...state.selectionModel,
        mode,
        ...(mode === 'query' ? {} : { queryDescriptor: null }),
      },
      ...(mode === 'query' ? {} : { querySelectionManifest: null }),
      // Clear selectedFilePaths when entering rules mode to avoid stale explicit selections
      // (will be repopulated by setMaterializedPaths when rules are evaluated)
      ...(isEnteringRulesMode || isEnteringQueryMode
        ? { selectedFilePaths: new Set<string>() }
        : {}),
      selectionVersion: state.selectionVersion + 1,
    }));
  },

  setSelectionRules: (ruleSetJson: string) => {
    set((state: FileExplorerState) => ({
      querySelectionManifest: null,
      selectionModel: {
        ...state.selectionModel,
        materializedAt: null,
        // Clear materialized cache when rules change
        materializedPaths: null,
        queryDescriptor: null,
        ruleSetJson,
      },
      selectionVersion: state.selectionVersion + 1,
    }));
  },
});
