/**
 * File system node types
 */
export type FileNodeType = 'file' | 'directory' | 'loadMore';

/**
 * Selection state for a file node
 */
export type SelectionState = 'checked' | 'unchecked' | 'indeterminate';

/**
 * Represents a file or directory in the file system
 */
export type IFileNode = {
  name: string;
  path: string;
  type: FileNodeType;
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  depth: number;
  selectionState: SelectionState;
  children?: IFileNode[];
  isVisible?: boolean;
  rootFolderId: string;
  size?: number;
  lastModified?: number;
  isSymbolicLink?: boolean;
  isDepthTruncated?: boolean;
};

/**
 * Options for file filtering
 */
export type FileFilterOptions = {
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
};

/**
 * Result of a file tree operation
 */
export type FileTreeResult = {
  nodes: IFileNode[];
  isComplete: boolean;
  error?: Error;
};

/**
 * File System API types - Global augmentations need careful handling in packages.
 * These might need to be in a specific .d.ts file included by the consuming package's tsconfig,
 * or managed differently depending on the project setup.
 * For now, including them here, but watch for TS errors.
 */
declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Interface required for global declaration merging - types cannot be merged
  interface Window {
    showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
  }

  // biome-ignore lint/style/useConsistentTypeDefinitions: Interface required for global declaration merging - types cannot be merged
  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }
}

// Cross-package compatible handle types used by stores and UI
export type DirectoryHandle = {
  path: string;
  name: string;
  kind: 'directory';
  platform: 'web' | 'electron';
  _internal?: unknown;
};

export type FileHandle = {
  path: string;
  name: string;
  kind: 'file';
  size?: number;
  platform: 'web' | 'electron';
  _internal?: unknown;
};

/**
 * Options that influence how adapters enumerate directories.
 */
export type DirectoryReadOptions = {
  /**
   * When false, adapters may skip expensive metadata calls (size/lastModified).
   * Defaults to true for backward compatibility.
   */
  includeMetadata?: boolean;
  /**
   * Maximum number of concurrent metadata operations (fs.stat/getFile, etc.).
   * Values <= 0 or non-finite are treated as "unlimited".
   */
  concurrency?: number;
};

export type FileSystemChange = {
  type: 'added' | 'removed' | 'modified';
  path: string;
  kind: 'file' | 'directory';
};

/**
 * Platform-agnostic adapter contract implemented by web/electron shims.
 */
export type FileSystemAdapter = {
  requestDirectoryAccess(): Promise<DirectoryHandle>;
  readDirectory(handle: DirectoryHandle, options?: DirectoryReadOptions): Promise<IFileNode[]>;
  readFile(handle: FileHandle): Promise<string>;
  exists(path: string): Promise<boolean>;
  watchDirectory?(
    handle: DirectoryHandle,
    callback: (changes: FileSystemChange[]) => void
  ): () => void;
  restoreLastFolder?(): Promise<DirectoryHandle | null>;
};
