import type { FileExplorerState, StoredRootDescriptor } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import type { GetState, SetState } from '../types/store-types';

const logger = createLogger('ActiveRootActions');

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
  /**
   * Declare the MAIN root: moves the given rootId to the FRONT of
   * activeRootIds (activeRootIds[0] = main root — the assistant's operating
   * root), preserving the relative order of the remaining ids. No-op when the
   * id is already first; warn-and-no-op for an unknown id. Never touches
   * rootDescriptors/folderStates and never changes the focused root
   * (currentFolderId) — main and focused are independent concepts.
   */
  setMainRoot: (rootId: string) => void;
}

export const createActiveRootActions = (
  set: SetState<FileExplorerState>,
  _get: GetState<FileExplorerState>
): ActiveRootActions => ({
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
  setActiveRoots: (roots: StoredRootDescriptor[]) => {
    set({
      activeRootIds: roots.map((r) => r.rootId),
      rootDescriptors: Object.fromEntries(roots.map((r) => [r.rootId, r])),
    });
  },
  setMainRoot: (rootId: string) => {
    set((state: FileExplorerState) => {
      if (!state.activeRootIds.includes(rootId)) {
        logger.warn('setMainRoot ignored: rootId is not an active root', { rootId });
        return {};
      }
      if (state.activeRootIds[0] === rootId) {
        // Already the main root — keep the array identity stable.
        return {};
      }
      return {
        activeRootIds: [rootId, ...state.activeRootIds.filter((id) => id !== rootId)],
      };
    });
  },
});
