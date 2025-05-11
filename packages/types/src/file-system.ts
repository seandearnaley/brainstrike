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
export interface IFileNode {
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
}

/**
 * Options for file filtering
 */
export interface FileFilterOptions {
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
}

/**
 * Result of a file tree operation
 */
export interface FileTreeResult {
  nodes: IFileNode[];
  isComplete: boolean;
  error?: Error;
}

/**
 * File System API types - Global augmentations need careful handling in packages.
 * These might need to be in a specific .d.ts file included by the consuming package's tsconfig,
 * or managed differently depending on the project setup.
 * For now, including them here, but watch for TS errors.
 */
declare global {
  interface Window {
    showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
  }

  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }
}
