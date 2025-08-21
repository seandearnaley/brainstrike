import type { IFileNode } from '@brainstrike/types';

/**
 * Options controlling how adapters read a directory.
 *
 * Defaults are chosen to preserve existing behavior while enabling performance tuning:
 *  - includeMetadata: true (fetch file size/lastModified)
 *  - concurrency: 64 (limit parallel metadata ops)
 *
 * Notes:
 *  - When includeMetadata is false, file nodes may omit `size` and `lastModified` to avoid extra I/O.
 *  - If concurrency is <= 0 or not finite, adapters treat it as "unlimited" (no limiter).
 *  - Adapters maintain consistent sorting (directories first, locale-aware name sort).
 */
export interface DirectoryReadOptions {
  /**
   * When false, skip fetching file metadata (e.g., size/lastModified) for faster initial listings.
   * Defaults to true to preserve backward compatibility.
   */
  includeMetadata?: boolean;
  /**
   * Max number of concurrent metadata operations (fs.stat / getFile, etc.).
   * Defaults to 64; values <= 0 or non-finite are treated as unlimited.
   */
  concurrency?: number;
}

export interface FileSystemAdapter {
  /**
   * Request access to a directory (web: file picker, electron: dialog)
   */
  requestDirectoryAccess(): Promise<DirectoryHandle>;

  /**
   * Read directory contents
   */
  readDirectory(handle: DirectoryHandle, options?: DirectoryReadOptions): Promise<IFileNode[]>;

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
