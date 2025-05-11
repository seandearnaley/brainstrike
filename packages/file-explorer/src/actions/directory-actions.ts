/**
 * Directory Actions
 *
 * This module contains actions for managing directory expansion state in the file explorer.
 * These actions handle expanding and collapsing directories while maintaining state persistence.
 */

import type { FileExplorerState } from '@brainstrike/types';

export const createDirectoryActions = (
  set: (fn: (state: FileExplorerState) => Partial<FileExplorerState>) => void,
  get: () => FileExplorerState
) => ({
  setExpandedPaths: (paths: ReadonlySet<string>) => {
    set(() => ({ expandedDirectoryPaths: new Set(paths) }));
  },

  toggleDirectoryExpansion: (path: string) => {
    const state = get();
    const newExpandedPaths = new Set(state.expandedDirectoryPaths);
    if (newExpandedPaths.has(path)) {
      newExpandedPaths.delete(path);
    } else {
      newExpandedPaths.add(path);
    }
    set(() => ({ expandedDirectoryPaths: newExpandedPaths }));
  },
});
