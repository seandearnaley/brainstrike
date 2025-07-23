import type { IFileNode } from '@brainstrike/types';

export interface FileSystemAdapter {
  /**
   * Request access to a directory (web: file picker, electron: dialog)
   */
  requestDirectoryAccess(): Promise<DirectoryHandle>;

  /**
   * Read directory contents
   */
  readDirectory(handle: DirectoryHandle): Promise<IFileNode[]>;

  /**
   * Read file contents
   */
  readFile(handle: FileHandle): Promise<string>;

  /**
   * Check if path exists
   */
  exists(path: string): Promise<boolean>;

  /**
   * Watch directory for changes (if supported)
   */
  watchDirectory?(
    handle: DirectoryHandle,
    callback: (changes: FileSystemChange[]) => void
  ): () => void;

  /**
   * Restore the last selected folder (if supported and available)
   * Used for desktop apps to auto-restore previously opened folders
   */
  restoreLastFolder?(): Promise<DirectoryHandle | null>;
}

export interface DirectoryHandle {
  path: string;
  name: string;
  kind: 'directory';
  platform: 'web' | 'electron';
  // Platform-specific data stored here
  _internal?: unknown;
}

export interface FileHandle {
  path: string;
  name: string;
  kind: 'file';
  size?: number;
  platform: 'web' | 'electron';
  // Platform-specific data stored here
  _internal?: unknown;
}

export interface FileSystemChange {
  type: 'added' | 'removed' | 'modified';
  path: string;
  kind: 'file' | 'directory';
}
