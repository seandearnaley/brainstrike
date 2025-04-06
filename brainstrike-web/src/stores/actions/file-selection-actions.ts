import type { StateCreator, StoreApi, UseBoundStore } from 'zustand';
import { encodeFileSelection } from '../../utils/file-selection-utils';
import type { FileExplorerState } from '../types/file-explorer-types';

type SetState<T> = UseBoundStore<StoreApi<T>>['setState'];
type GetState<T> = UseBoundStore<StoreApi<T>>['getState'];

export interface FileSelectionActions {
  setSelectedFiles: (selectedFiles: ReadonlySet<string>) => void;
  addSelectedFile: (folderId: string, path: string) => void;
  removeSelectedFile: (folderId: string, path: string) => void;
  toggleSelectedFile: (folderId: string, path: string) => void;
  clearSelectedFiles: () => void;
}

export const createFileSelectionActions = (
  set: SetState<FileExplorerState>,
  _get: GetState<FileExplorerState> // Marked as unused
): FileSelectionActions => ({
  setSelectedFiles: (selectedFiles: ReadonlySet<string>) => {
    // Ensure all files in the set are properly encoded composite keys
    const validatedFiles = new Set<string>();
    for (const file of selectedFiles) {
      // Only add files that are already in composite key format
      if (file.includes('|@|')) {
        validatedFiles.add(file);
      }
    }
    set({ selectedFilePaths: validatedFiles });
  },

  addSelectedFile: (folderId: string, path: string) => {
    set((state) => {
      const newSelectedFiles = new Set(state.selectedFilePaths);
      // Check against maxSelectionCount before adding
      if (newSelectedFiles.size < state.maxSelectionCount) {
        newSelectedFiles.add(encodeFileSelection(folderId, path));
      }
      return { selectedFilePaths: newSelectedFiles };
    });
  },

  removeSelectedFile: (folderId: string, path: string) => {
    set((state) => {
      const newSelectedFiles = new Set(state.selectedFilePaths);
      newSelectedFiles.delete(encodeFileSelection(folderId, path));
      return { selectedFilePaths: newSelectedFiles };
    });
  },

  toggleSelectedFile: (folderId: string, path: string) => {
    set((state) => {
      const newSelectedFiles = new Set(state.selectedFilePaths);
      const compositeKey = encodeFileSelection(folderId, path);
      if (newSelectedFiles.has(compositeKey)) {
        newSelectedFiles.delete(compositeKey);
      } else {
        // Check against maxSelectionCount before adding
        if (newSelectedFiles.size < state.maxSelectionCount) {
          newSelectedFiles.add(compositeKey);
        }
      }
      return { selectedFilePaths: newSelectedFiles };
    });
  },

  clearSelectedFiles: () => {
    set({ selectedFilePaths: new Set() });
  },
});
