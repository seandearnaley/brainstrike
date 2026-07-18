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
   * ORDER-PRESERVING (restore-order fix): the Main root is
   * `activeRootIds[0]`, declared via `setMainRoot` and persisted as the
   * order of `activeRootIds` (file-explorer-storage v5) — there is no
   * separate `mainRootId` field. On desktop, `roots` here arrives from the
   * main-process rootsList (add-order, no notion of Main), so a plain
   * `roots.map(r => r.rootId)` overwrite would silently discard a
   * previously-declared Main choice on every restart. Instead: ids already
   * present in the current (rehydrated) `activeRootIds` keep their existing
   * relative order — including the Main slot — and any id newly reported in
   * `roots` that wasn't previously known is appended at the END (mirrors
   * `addActiveRoot`/re-add-after-remove demotion semantics). An id no longer
   * reported (e.g. pruned as missing-on-disk) is dropped.
   * rootDescriptors = keyed by rootId (always replaced from the given roots).
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
    set((state: FileExplorerState) => {
      const reportedIds = roots.map((r) => r.rootId);
      const reportedIdSet = new Set(reportedIds);
      // Keep the existing (possibly Main-reordered) relative order for ids
      // still reported; a ghost id no longer reported is dropped.
      const preservedOrder = state.activeRootIds.filter((id) => reportedIdSet.has(id));
      const preservedIdSet = new Set(preservedOrder);
      // A newly-reported id we've never seen before joins at the end.
      const newlyDiscovered = reportedIds.filter((id) => !preservedIdSet.has(id));
      return {
        activeRootIds: [...preservedOrder, ...newlyDiscovered],
        rootDescriptors: Object.fromEntries(roots.map((r) => [r.rootId, r])),
      };
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
