import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';

declare module 'electron';

export interface ElectronAPI {
  storage: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
    clear: () => Promise<void>;
    getAllKeys: () => Promise<string[]>;
  };
  fs: {
    requestDirectoryAccess: () => Promise<DirectoryHandle>;
    readDirectory: (handle: DirectoryHandle) => Promise<IFileNode[]>;
    readFile: (handle: FileHandle) => Promise<string>;
    exists: (path: string) => Promise<boolean>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
