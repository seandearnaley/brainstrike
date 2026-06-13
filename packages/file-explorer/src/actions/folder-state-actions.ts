import {
  createEmptySelectionModel,
  type FileExplorerState,
  type FolderState,
  type SelectionModel,
} from '@brainstrike/types';
import type { GetState, SetState } from '../types/store-types';
import {
  cleanupOldFolderStates,
  createNewFolderState,
  saveFolderState,
  updateFolderAccessOrder,
} from '../utils/file-explorer-utils';

/**
 * FOREST INVARIANT: hydrated selections are ALWAYS explicit when multiple
 * roots are active. A persisted query-mode snapshot (pre-invariant profiles)
 * references a top-level manifest that no longer exists — restoring it
 * verbatim produces a phantom selection (checkbox state and counts disagree
 * with the keys actually present). Degrade it to the explicit keys the
 * snapshot DOES carry. Single-root restores keep the query model — its
 * resolver rebuilds the manifest from the persisted snapshotId.
 */
function normalizeHydratedSelectionModel(
  state: Pick<FileExplorerState, 'activeRootIds'>,
  folderState: FolderState
): SelectionModel {
  const isForest = (state.activeRootIds?.length ?? 0) > 1;
  if (isForest && folderState.selectionModel.mode === 'query') {
    return {
      ...createEmptySelectionModel(),
      explicitPaths: new Set(folderState.selectedFilePaths),
    };
  }
  return folderState.selectionModel;
}

export interface FolderStateActions {
  hydrateFolderState: (folderId: string) => void;
  setCurrentFolderId: (folderId: string | null) => void;
  /**
   * Replace a NON-FOCUSED root's explicit selection in its folderState
   * (cross-root selection write-back, Phase 6). Does NOT touch the focused
   * top-level selection or currentFolderId — the focused root's live value
   * is the top-level set; callers must route focused keys there instead.
   * Creates the folderState (reset shape) when the root has none yet.
   */
  setFolderSelection: (folderId: string, compositeKeys: readonly string[]) => void;
}

/** Build the state update for restoring an existing folder */
function buildRestoreState(
  state: Pick<FileExplorerState, 'activeRootIds'>,
  folderId: string,
  folderState: FolderState,
  folderStates: Record<string, FolderState>,
  order: string[]
): Partial<FileExplorerState> {
  return {
    currentFolderId: folderId,
    folderStates,
    folderAccessOrder: order,
    selectedFilePaths: new Set(folderState.selectedFilePaths),
    selectionModel: normalizeHydratedSelectionModel(state, folderState),
    querySelectionManifest: null,
    // WORKSPACE-GLOBAL state is never hydrated from folder snapshots:
    // maxSelectionCount, includeFilters, excludeFilters, useRegex,
    // viewFilterPresetId, expandedDirectoryPaths, tokenBudget,
    // includeProjectTree, folderSummaryThreshold, and lastActiveTab. Forest
    // mode switches focus on every section click; stale per-folder copies
    // would silently revert the user's setting per clicked root (caps
    // flipping, "all files" reverting, expansions collapsing, the token
    // budget / ACTIVE TAB flipping mid-click). Only the SELECTION
    // (selectedFilePaths + selectionModel) is genuinely per-root.
  };
}

/** Build the state update for creating a new folder */
function buildNewFolderState(
  folderId: string,
  folderStates: Record<string, FolderState>,
  order: string[]
): Partial<FileExplorerState> {
  return {
    currentFolderId: folderId,
    folderStates,
    folderAccessOrder: order,
    selectedFilePaths: new Set<string>(),
    selectionModel: createNewFolderState().selectionModel,
    querySelectionManifest: null,
    // expandedDirectoryPaths is WORKSPACE-GLOBAL — focusing a brand-new root
    // must not collapse every other section's expansions.
  };
}

/** Build the state update for resetting (no folder selected) */
function buildResetState(
  folderStates: Record<string, FolderState>,
  order: string[]
): Partial<FileExplorerState> {
  return {
    currentFolderId: null,
    folderStates,
    folderAccessOrder: order,
    selectedFilePaths: new Set<string>(),
    selectionModel: createNewFolderState().selectionModel,
    querySelectionManifest: null,
    expandedDirectoryPaths: new Set<string>(),
  };
}

/** Prepare folder states by saving current and cleaning up old ones */
function prepareFolderStates(
  state: FileExplorerState,
  currentFolderId: string | null
): { folderStates: Record<string, FolderState>; order: string[] } {
  let updatedFolderStates = { ...state.folderStates };
  let updatedOrder = state.folderAccessOrder;

  if (currentFolderId) {
    updatedFolderStates = saveFolderState(state, currentFolderId);
    updatedOrder = updateFolderAccessOrder(updatedOrder, currentFolderId);
  }

  return cleanupOldFolderStates(updatedFolderStates, updatedOrder);
}

/** Handle restoring an existing folder's state */
function handleRestoreFolder(
  set: SetState<FileExplorerState>,
  state: Pick<FileExplorerState, 'activeRootIds'>,
  folderId: string,
  folderState: FolderState,
  folderStates: Record<string, FolderState>,
  order: string[]
): void {
  const updatedOrder = updateFolderAccessOrder(order, folderId);
  set(buildRestoreState(state, folderId, folderState, folderStates, updatedOrder));
}

/** Handle creating a new folder state */
function handleCreateNewFolder(
  set: SetState<FileExplorerState>,
  state: FileExplorerState,
  folderId: string,
  folderStates: Record<string, FolderState>,
  order: string[]
): void {
  const updatedFolderStates = { ...folderStates, [folderId]: createNewFolderState(state) };
  let updatedOrder = updateFolderAccessOrder(order, folderId);
  const cleaned = cleanupOldFolderStates(updatedFolderStates, updatedOrder);
  updatedOrder = cleaned.order;
  set(buildNewFolderState(folderId, cleaned.folderStates, updatedOrder));
}

export const createFolderStateActions = (
  set: SetState<FileExplorerState>,
  get: GetState<FileExplorerState>
): FolderStateActions => ({
  setCurrentFolderId: (folderId: string | null) => {
    const state = get();
    const currentFolderId = state.currentFolderId;

    if (folderId === currentFolderId) {
      return;
    }

    const { folderStates, order } = prepareFolderStates(state, currentFolderId);
    const existingFolderState = folderStates[folderId as string];

    if (folderId && existingFolderState) {
      handleRestoreFolder(set, state, folderId, existingFolderState, folderStates, order);
    } else if (folderId) {
      handleCreateNewFolder(set, state, folderId, folderStates, order);
    } else {
      set(buildResetState(folderStates, order));
    }
  },

  setFolderSelection: (folderId: string, compositeKeys: readonly string[]) => {
    set((state) => {
      const base = state.folderStates[folderId] ?? createNewFolderState(state);
      const selected = new Set(compositeKeys);
      return {
        folderStates: {
          ...state.folderStates,
          [folderId]: {
            ...base,
            lastAccessed: Date.now(),
            selectedFilePaths: selected,
            selectionModel: {
              ...base.selectionModel,
              mode: 'explicit',
              explicitPaths: new Set(compositeKeys),
            },
          },
        },
      };
    });
  },

  hydrateFolderState: (folderId: string) => {
    set((state) => {
      const folderState = state.folderStates[folderId];
      if (!folderState) {
        return {};
      }

      const updatedFolderState = { ...folderState, lastAccessed: Date.now() };
      const order = updateFolderAccessOrder(state.folderAccessOrder, folderId);

      return {
        folderStates: { ...state.folderStates, [folderId]: updatedFolderState },
        folderAccessOrder: order,
        selectedFilePaths: new Set(folderState.selectedFilePaths),
        selectionModel: normalizeHydratedSelectionModel(state, folderState),
        querySelectionManifest: null,
        // WORKSPACE-GLOBAL state is never hydrated — see buildRestoreState.
        // Only the selection is per-root.
      };
    });
  },
});
