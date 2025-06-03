import type { FileExplorerState } from '@brainstrike/types';
import type { StateCreator } from 'zustand';

export function createFileContentActions(
  set: Parameters<StateCreator<FileExplorerState>>[0],
  _get: Parameters<StateCreator<FileExplorerState>>[1]
) {
  return {
    setFileContent: (compositeKey: string, content: string) => {
      set((state) => ({
        fileContents: {
          ...state.fileContents,
          [compositeKey]: content,
        },
      }));
    },

    clearFileContents: (compositeKeys: string[]) => {
      set((state) => {
        const newFileContents = { ...state.fileContents };
        for (const key of compositeKeys) {
          delete newFileContents[key];
        }
        return { fileContents: newFileContents };
      });
    },

    clearAllFileContents: () => {
      set({ fileContents: {} });
    },
  };
}
