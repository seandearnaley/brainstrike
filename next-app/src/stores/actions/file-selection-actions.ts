/**
 * File Selection Actions
 *
 * This module contains actions for managing file selection state in the file explorer.
 * These actions handle adding, removing, and toggling file selections while respecting
 * the maximum selection limit.
 */

import { encodeFileSelection } from '@/utils/file-selection-utils';
import type { FileExplorerState } from '../types/file-explorer-types';

export const createFileSelectionActions = (
  set: (fn: (state: FileExplorerState) => Partial<FileExplorerState>) => void,
  get: () => FileExplorerState
) => ({
  setSelectedFiles: (selectedFiles: ReadonlySet<string>) => {
    set(() => ({ selectedFilePaths: new Set(selectedFiles) }));
  },

  addSelectedFile: (_folderId: string, path: string) => {
    const state = get();
    if (!state.currentFolderId) return;

    // Check if adding this file would exceed the max selection count
    if (state.selectedFilePaths.size >= state.maxSelectionCount) {
      console.warn(`Cannot select more than ${state.maxSelectionCount} files`);
      return;
    }

    const newSelectedFiles = new Set(state.selectedFilePaths);
    newSelectedFiles.add(encodeFileSelection(state.currentFolderId, path));
    set(() => ({ selectedFilePaths: newSelectedFiles }));
  },

  removeSelectedFile: (_folderId: string, path: string) => {
    const state = get();
    if (!state.currentFolderId) return;
    const newSelectedFiles = new Set(state.selectedFilePaths);
    newSelectedFiles.delete(encodeFileSelection(state.currentFolderId, path));
    set(() => ({ selectedFilePaths: newSelectedFiles }));
  },

  toggleSelectedFile: (_folderId: string, path: string) => {
    const state = get();
    if (!state.currentFolderId) return;

    const compositeKey = encodeFileSelection(state.currentFolderId, path);
    const newSelectedFiles = new Set(state.selectedFilePaths);
    if (newSelectedFiles.has(compositeKey)) {
      newSelectedFiles.delete(compositeKey);
    } else {
      if (newSelectedFiles.size >= state.maxSelectionCount) {
        console.warn(`Cannot select more than ${state.maxSelectionCount} files`);
        return;
      }
      newSelectedFiles.add(compositeKey);
    }
    set(() => ({ selectedFilePaths: newSelectedFiles }));
  },

  clearSelectedFiles: () => {
    set(() => ({ selectedFilePaths: new Set() }));
  },
});
