import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import type { PanelPersistenceState } from '@brainstrike/ui';

// Type definitions for the Electron API exposed via contextBridge
declare global {
  interface Window {
    electronAPI: {
      storage: {
        getItem: (key: string) => Promise<string | null>;
        setItem: (key: string, value: string) => Promise<void>;
        removeItem: (key: string) => Promise<void>;
        clear: () => Promise<void>;
        getAllKeys: () => Promise<string[]>;
      };
      fileSystem: {
        requestDirectoryAccess: () => Promise<DirectoryHandle>;
        readDirectory: (handle: DirectoryHandle) => Promise<IFileNode[]>;
        readFile: (handle: FileHandle) => Promise<string>;
        exists: (path: string) => Promise<boolean>;
      };
      // Layout persistence methods
      saveLayout: (state: PanelPersistenceState) => Promise<void>;
      loadLayout: () => Promise<PanelPersistenceState | undefined>;
      // Database path method
      getUserDataPath: () => Promise<string>;
    };
  }
}
