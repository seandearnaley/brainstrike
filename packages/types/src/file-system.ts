/**
 * File system node types
 */
export type FileNodeType = 'file' | 'directory' | 'loadMore';

/**
 * Selection state for a file node
 */
export type SelectionState = 'checked' | 'unchecked' | 'indeterminate';

/**
 * Loading state for lazy-loaded directories
 *
 * - 'unloaded': Directory children have not been loaded yet (show expand arrow)
 * - 'loading': Directory children are currently being loaded (show spinner)
 * - 'loaded': Directory children have been loaded (children array is populated)
 * - 'error': Failed to load directory children
 */
export type DirectoryLoadState = 'unloaded' | 'loading' | 'loaded' | 'error';

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
  /**
   * Loading state for directories (lazy loading).
   * - undefined: Not applicable (files) or legacy nodes
   * - 'unloaded': Children not yet loaded
   * - 'loading': Currently loading children
   * - 'loaded': Children have been loaded
   * - 'error': Failed to load children
   */
  loadState?: DirectoryLoadState;
  /** Error message when loadState is 'error' */
  loadError?: string;
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
 * Depth-based progress tracking for tree loading
 */
export type DepthProgress = {
  /** Deepest depth currently being processed */
  currentDepth: number;
  /** Maximum depth encountered so far */
  maxDepthSeen: number;
  /** Estimated total depth (starts at 5, adjusts dynamically) */
  estimatedMaxDepth: number;
  /** Number of directories fully processed */
  directoriesCompleted: number;
  /** Number of directories still in queue */
  directoriesRemaining: number;
  /** Total files discovered so far */
  filesFound: number;
};

/**
 * Metadata emitted with each streaming tree snapshot
 */
export type StreamMeta = {
  /** Whether this is the final snapshot (tree complete) */
  isComplete: boolean;
  /** Current depth-based progress */
  depthProgress: DepthProgress;
  /** Total nodes (files + directories) discovered */
  totalNodesDiscovered: number;
  /** Milliseconds elapsed since loading started */
  elapsedMs: number;
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

/**
 * Options for streaming directory enumeration (BST-147).
 * Extends DirectoryReadOptions with streaming-specific options.
 */
export type StreamingDirectoryReadOptions = DirectoryReadOptions & {
  /**
   * Number of entries to batch before calling onBatch.
   * Smaller batches = more responsive UI, larger = fewer re-renders.
   * Default: 50
   */
  batchSize?: number;
  /**
   * AbortSignal for cancellation support.
   * When aborted, streaming stops and no further batches are emitted.
   */
  signal?: AbortSignal;
};

/**
 * Callback for receiving batches of directory entries during streaming.
 *
 * @param nodes - The batch of nodes discovered in this iteration
 * @param meta - Metadata about the streaming progress
 */
export type DirectoryStreamCallback = (
  nodes: IFileNode[],
  meta: { done: boolean; total: number }
) => void;

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
  /**
   * Stream directory contents with batched callbacks (BST-147).
   *
   * For large directories, this provides progressive loading by calling
   * `onBatch` with groups of entries as they're discovered. This keeps
   * the UI responsive instead of blocking until all entries are read.
   *
   * @param handle - Directory to enumerate
   * @param onBatch - Called with each batch of entries; `meta.done` indicates final batch
   * @param options - Streaming options including batchSize and AbortSignal
   * @returns Promise that resolves when streaming completes or rejects on error
   *
   * @example
   * ```ts
   * await adapter.readDirectoryStreaming?.(
   *   handle,
   *   (nodes, { done, total }) => {
   *     setState(prev => [...prev, ...nodes]);
   *     if (done) console.log(`Loaded ${total} entries`);
   *   },
   *   { batchSize: 50, signal: abortController.signal }
   * );
   * ```
   */
  readDirectoryStreaming?(
    handle: DirectoryHandle,
    onBatch: DirectoryStreamCallback,
    options?: StreamingDirectoryReadOptions
  ): Promise<void>;
};
