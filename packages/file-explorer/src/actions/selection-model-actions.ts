/**
 * Selection Model Actions
 *
 * Actions for managing the selection model which supports explicit
 * path-based selection and query-backed selection modes.
 */

import type {
  FileExplorerState,
  QuerySelectionManifest,
  SelectionMode,
  SelectionQueryDescriptor,
} from '@brainstrike/types';
import type { SetState } from '../types/store-types';

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
  resetSelectionToExplicit: () => void;
  setQuerySelection: (
    descriptor: SelectionQueryDescriptor,
    manifest: QuerySelectionManifest,
    materializedPaths?: Set<string>
  ) => void;
  setQuerySelectionManifest: (manifest: QuerySelectionManifest | null) => void;
  setSelectionMode: (mode: SelectionMode) => void;
}

export const createSelectionModelActions = (
  set: SetState<FileExplorerState>
): SelectionModelActions => ({
  resetSelectionToExplicit: () => {
    set((state: FileExplorerState) => ({
      querySelectionManifest: null,
      selectionModel: {
        ...state.selectionModel,
        materializedAt: null,
        materializedPaths: null,
        mode: 'explicit',
        queryDescriptor: null,
      },
      selectionVersion: state.selectionVersion + 1,
    }));
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
    set((state: FileExplorerState) => {
      const isEnteringQueryMode = mode === 'query' && state.selectionModel.mode !== 'query';
      return {
        selectionModel: {
          ...state.selectionModel,
          mode,
          ...(mode === 'query' ? {} : { queryDescriptor: null }),
        },
        ...(mode === 'query' ? {} : { querySelectionManifest: null }),
        // Clear selectedFilePaths when entering query mode to avoid stale
        // explicit selections lingering under the query-backed selection.
        ...(isEnteringQueryMode ? { selectedFilePaths: new Set<string>() } : {}),
        selectionVersion: state.selectionVersion + 1,
      };
    });
  },
});
