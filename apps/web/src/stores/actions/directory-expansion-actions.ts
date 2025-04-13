import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import type { StoreApi, UseBoundStore } from 'zustand';

type SetState<T> = UseBoundStore<StoreApi<T>>['setState'];
type GetState<T> = UseBoundStore<StoreApi<T>>['getState'];

export interface DirectoryExpansionActions {
  setExpandedPaths: (paths: ReadonlySet<string>) => void;
  toggleDirectoryExpansion: (path: string) => void;
  expandAllDirectories: (fileTree: IFileNode[]) => void;
  collapseAllDirectories: () => void;
}

export const createDirectoryExpansionActions = (
  set: SetState<FileExplorerState>,
  _get: GetState<FileExplorerState> // Marked as unused
): DirectoryExpansionActions => ({
  setExpandedPaths: (paths: ReadonlySet<string>) => {
    set({ expandedDirectoryPaths: new Set(paths) });
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
      return { expandedDirectoryPaths: newExpandedPaths };
    });
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
      return { expandedDirectoryPaths: newExpandedPaths };
    });
  },

  collapseAllDirectories: () => {
    set({ expandedDirectoryPaths: new Set() });
  },
});
