import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import type { GetState, SetState } from '../types/store-types';

export interface DirectoryExpansionActions {
  collapseAllDirectories: () => void;
  expandAllDirectories: (fileTree: IFileNode[]) => void;
  /**
   * Replace the expanded set. ADOPTS the passed set (no defensive clone —
   * every caller hands over a freshly built set, and cloning here doubled the
   * per-commit allocation during progressive expand-all). Ownership transfers:
   * callers must not mutate the set after passing it.
   */
  setExpandedPaths: (paths: Set<string>) => void;
  toggleDirectoryExpansion: (path: string) => void;
}

/**
 * Helper to update both global and per-folder expanded paths.
 * This ensures persistence works correctly - folder state is saved with the expanded paths.
 */
function updateExpandedPaths(
  state: FileExplorerState,
  newExpandedPaths: Set<string>
): Partial<FileExplorerState> {
  const updates: Partial<FileExplorerState> = {
    expandedDirectoryPaths: newExpandedPaths,
  };

  // Also update the current folder's state for persistence
  const folderId = state.currentFolderId;
  if (folderId && state.folderStates[folderId]) {
    updates.folderStates = {
      ...state.folderStates,
      [folderId]: {
        ...state.folderStates[folderId],
        expandedDirectoryPaths: newExpandedPaths,
        lastAccessed: Date.now(),
      },
    };
  }

  return updates;
}

export const createDirectoryExpansionActions = (
  set: SetState<FileExplorerState>,
  _get: GetState<FileExplorerState> // Marked as unused
): DirectoryExpansionActions => ({
  collapseAllDirectories: () => {
    set((state) => updateExpandedPaths(state, new Set()));
  },

  expandAllDirectories: (fileTree: IFileNode[]) => {
    set((state) => {
      const newExpandedPaths = new Set(state.expandedDirectoryPaths);
      const addDirectoryPaths = (nodes: IFileNode[]) => {
        for (const node of nodes) {
          if (node.type === 'directory') {
            newExpandedPaths.add(node.path);
            if (node.children) {
              addDirectoryPaths(node.children);
            }
          }
        }
      };
      addDirectoryPaths(fileTree);
      return updateExpandedPaths(state, newExpandedPaths);
    });
  },
  setExpandedPaths: (paths: Set<string>) => {
    set((state) => updateExpandedPaths(state, paths));
  },

  toggleDirectoryExpansion: (path: string) => {
    set((state) => {
      const newExpandedPaths = new Set(state.expandedDirectoryPaths);
      if (newExpandedPaths.has(path)) {
        newExpandedPaths.delete(path);
        // Optimization: Remove child paths when parent is collapsed
        for (const childPath of Array.from(newExpandedPaths)) {
          if (childPath.startsWith(`${path}/`)) {
            newExpandedPaths.delete(childPath);
          }
        }
      } else {
        newExpandedPaths.add(path);
      }
      return updateExpandedPaths(state, newExpandedPaths);
    });
  },
});
