import type { FileExplorerState } from '@brainstrike/types';
import { createLogger, encodeFileSelection } from '@brainstrike/utils';
import type { StoreApi, UseBoundStore } from 'zustand';

const logger = createLogger('FileSelectionActions');

type SetState<T> = UseBoundStore<StoreApi<T>>['setState'];
type GetState<T> = UseBoundStore<StoreApi<T>>['getState'];

export interface FileSelectionActions {
  setSelectedFiles: (selectedFiles: ReadonlySet<string>) => void;
  addSelectedFile: (folderId: string | null, path: string) => void;
  removeSelectedFile: (folderId: string | null, path: string) => void;
  toggleSelectedFile: (folderId: string | null, path: string) => void;
  clearSelectedFiles: () => void;
  addMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
  removeMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
}

export const createFileSelectionActions = (
  set: SetState<FileExplorerState>,
  _get: GetState<FileExplorerState> // Changed back to _get to indicate unused parameter
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

  addSelectedFile: (folderId: string | null, path: string) => {
    if (folderId === null) {
      return; // Skip if no folder is selected
    }
    set((state) => {
      const newSelectedFiles = new Set(state.selectedFilePaths);
      // Check against maxSelectionCount before adding
      if (newSelectedFiles.size < state.maxSelectionCount) {
        newSelectedFiles.add(encodeFileSelection(folderId, path));
      }
      return { selectedFilePaths: newSelectedFiles };
    });
  },

  removeSelectedFile: (folderId: string | null, path: string) => {
    if (folderId === null) {
      return; // Skip if no folder is selected
    }
    set((state) => {
      const newSelectedFiles = new Set(state.selectedFilePaths);
      newSelectedFiles.delete(encodeFileSelection(folderId, path));
      return { selectedFilePaths: newSelectedFiles };
    });
  },

  toggleSelectedFile: (folderId: string | null, path: string) => {
    if (folderId === null) {
      return; // Skip if no folder is selected
    }
    set((state) => {
      const newSelectedFiles = new Set(state.selectedFilePaths);
      const compositeKey = encodeFileSelection(folderId, path);
      if (newSelectedFiles.has(compositeKey)) {
        newSelectedFiles.delete(compositeKey);
      } else if (newSelectedFiles.size < state.maxSelectionCount) {
        // Check against maxSelectionCount before adding
        newSelectedFiles.add(compositeKey);
      }
      return { selectedFilePaths: newSelectedFiles };
    });
  },

  clearSelectedFiles: () => {
    set({ selectedFilePaths: new Set() });
  },

  addMultipleSelectedFiles: (folderId: string, paths: string[]) => {
    logger.info('addMultipleSelectedFiles called', {
      folderId,
      pathCount: paths.length,
      samplePaths: paths.slice(0, 3),
    });

    set((state) => {
      const newSelectedFiles = new Set(state.selectedFilePaths);
      const previousSize = newSelectedFiles.size;
      let currentSize = previousSize;

      for (const path of paths) {
        if (currentSize >= state.maxSelectionCount) {
          break; // Stop if max selection count is reached
        }
        const compositeKey = encodeFileSelection(folderId, path);
        if (!newSelectedFiles.has(compositeKey)) {
          newSelectedFiles.add(compositeKey);
          currentSize++;
        }
      }

      logger.info('addMultipleSelectedFiles complete', {
        previousSize,
        newSize: newSelectedFiles.size,
        addedCount: newSelectedFiles.size - previousSize,
        sampleKeys: [...newSelectedFiles].slice(0, 3),
      });

      return { selectedFilePaths: newSelectedFiles };
    });
  },

  removeMultipleSelectedFiles: (folderId: string, paths: string[]) => {
    set((state) => {
      const newSelectedFiles = new Set(state.selectedFilePaths);
      for (const path of paths) {
        const compositeKey = encodeFileSelection(folderId, path);
        newSelectedFiles.delete(compositeKey);
      }
      return { selectedFilePaths: newSelectedFiles };
    });
  },
});
