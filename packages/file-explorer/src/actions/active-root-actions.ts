import type { FileExplorerState, StoredRootDescriptor } from '@brainstrike/types';
import type { GetState, SetState } from '../types/store-types';

export interface ActiveRootActions {
  /**
   * Append a new root if absent by rootId; if the rootId already exists,
   * update its descriptor (displayName/path refresh) without appending again.
   */
  addActiveRoot: (root: StoredRootDescriptor) => void;
  /**
   * Disconnect a root: atomically purge it from activeRootIds, rootDescriptors,
   * folderStates, and folderAccessOrder in ONE setState. Does NOT touch
   * currentFolderId — the hook layer shifts focus via setCurrentFolderId
   * BEFORE calling this (setCurrentFolderId snapshots the outgoing folder's
   * live state back into folderStates, so the purge must come last).
   */
  removeActiveRoot: (rootId: string) => void;
  /**
   * Replace both activeRootIds and rootDescriptors atomically.
   * activeRootIds = roots.map(r => r.rootId) (ordered).
   * rootDescriptors = keyed by rootId.
   */
  setActiveRoots: (roots: StoredRootDescriptor[]) => void;
}

export const createActiveRootActions = (
  set: SetState<FileExplorerState>,
  _get: GetState<FileExplorerState>
): ActiveRootActions => ({
  setActiveRoots: (roots: StoredRootDescriptor[]) => {
    set({
      activeRootIds: roots.map((r) => r.rootId),
      rootDescriptors: Object.fromEntries(roots.map((r) => [r.rootId, r])),
    });
  },

  addActiveRoot: (root: StoredRootDescriptor) => {
    set((state: FileExplorerState) => {
      const alreadyPresent = state.activeRootIds.includes(root.rootId);
      return {
        // Only append the id if it is not already in the list
        activeRootIds: alreadyPresent ? state.activeRootIds : [...state.activeRootIds, root.rootId],
        // Always refresh the descriptor so displayName/path stay current
        rootDescriptors: {
          ...state.rootDescriptors,
          [root.rootId]: root,
        },
      };
    });
  },

  removeActiveRoot: (rootId: string) => {
    set((state: FileExplorerState) => {
      const { [rootId]: _removedDescriptor, ...remainingDescriptors } = state.rootDescriptors;
      const { [rootId]: _removedFolderState, ...remainingFolderStates } = state.folderStates;
      return {
        activeRootIds: state.activeRootIds.filter((id) => id !== rootId),
        folderAccessOrder: state.folderAccessOrder.filter((id) => id !== rootId),
        folderStates: remainingFolderStates,
        rootDescriptors: remainingDescriptors,
      };
    });
  },
});
