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
export interface IFileNode {
  children?: IFileNode[];
  depth: number;
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  isDepthTruncated?: boolean;
  isSymbolicLink?: boolean;
  isVisible?: boolean;
  lastModified?: number;
  /** Error message when loadState is 'error' */
  loadError?: string;
  /**
   * Loading state for directories (lazy loading).
   * - undefined: Not applicable (files) or legacy nodes
   * - 'unloaded': Children not yet loaded
   * - 'loading': Currently loading children
   * - 'loaded': Children have been loaded
   * - 'error': Failed to load children
   */
  loadState?: DirectoryLoadState;
  name: string;
  path: string;
  rootFolderId: string;
  selectionState: SelectionState;
  size?: number;
  type: FileNodeType;
}

/**
 * Options for file filtering
 */
export interface FileFilterOptions {
  excludeFilters: string[];
  includeFilters: string[];
  useRegex: boolean;
}

/**
 * Result of a file tree operation
 */
export interface FileTreeResult {
  error?: Error;
  isComplete: boolean;
  nodes: IFileNode[];
}

/**
 * Depth-based progress tracking for tree loading
 */
export interface DepthProgress {
  /** Deepest depth currently being processed */
  currentDepth: number;
  /** Number of directories fully processed */
  directoriesCompleted: number;
  /** Number of directories still in queue */
  directoriesRemaining: number;
  /** Estimated total depth (starts at 5, adjusts dynamically) */
  estimatedMaxDepth: number;
  /** Total files discovered so far */
  filesFound: number;
  /** Maximum depth encountered so far */
  maxDepthSeen: number;
}

/**
 * Metadata emitted with each streaming tree snapshot
 */
export interface StreamMeta {
  /** Current depth-based progress */
  depthProgress: DepthProgress;
  /** Milliseconds elapsed since loading started */
  elapsedMs: number;
  /** Whether this is the final snapshot (tree complete) */
  isComplete: boolean;
  /** Total nodes (files + directories) discovered */
  totalNodesDiscovered: number;
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

// Cross-package compatible handle types used by stores and UI
export interface DirectoryHandle {
  _internal?: unknown;
  kind: 'directory';
  name: string;
  path: string;
  platform: 'web' | 'electron';
  /**
   * Durable RootId, stamped when the handle becomes a registered root (storage
   * v5). Makes the handle SELF-IDENTIFYING so two same-named roots don't
   * collide: on web `path` is only the directory name (the FSA API hides the
   * absolute path), so two folders both named "project" share a path. Identity
   * resolution prefers this over `path`. Absent for legacy single-root handles
   * (the `setRoot`/`restoreLastFolder` path), where `path` is unique anyway.
   */
  rootId?: RootId;
}

/**
 * Durable identity for a user-selected root directory. Generated once when a
 * root is added (crypto.randomUUID) and stable across sessions. Never derived
 * from the directory name or path — names collide and web handles expose no
 * absolute path.
 */
export type RootId = string;

export type RootPermissionState = 'granted' | 'prompt' | 'denied' | 'unknown';

/**
 * A root directory known to the adapter's persistence layer.
 * - kind 'fsa': web — handle persisted in IndexedDB; permissionState reflects
 *   queryPermission at restore time (never prompts).
 * - kind 'path': desktop — absolute path persisted in main-process storage;
 *   permissionState is always 'granted' (OS-level access).
 */
export interface RootDescriptor {
  readonly displayName: string;
  readonly handle: DirectoryHandle;
  readonly kind: 'fsa' | 'path';
  readonly permissionState: RootPermissionState;
  /**
   * False when the backing store write failed (quota, privacy mode): the root
   * works for this session but won't survive reload and its rootId must NOT
   * be registered in the DB (a re-pick generates a new id, orphaning rows).
   */
  readonly persisted: boolean;
  readonly rootId: RootId;
}

export interface FileHandle {
  _internal?: unknown;
  kind: 'file';
  name: string;
  path: string;
  platform: 'web' | 'electron';
  rootFolderId?: string;
  size?: number;
}

/**
 * Options that influence how adapters enumerate directories.
 */
export interface DirectoryReadOptions {
  /**
   * Maximum number of concurrent metadata operations (fs.stat/getFile, etc.).
   * Values <= 0 or non-finite are treated as "unlimited".
   */
  concurrency?: number;
  /**
   * When false, adapters may skip expensive metadata calls (size/lastModified).
   * Defaults to true for backward compatibility.
   */
  includeMetadata?: boolean;
}

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

export interface FileSystemChange {
  kind: 'file' | 'directory';
  path: string;
  type: 'added' | 'removed' | 'modified';
}

/**
 * Resolution shape returned by `FileSystemAdapter.resolveFileForIndexing`.
 *
 * - `kind: 'handle'` — the adapter has a real `FileSystemFileHandle` that the
 *   indexer worker can consume directly via structured clone (production web).
 * - `kind: 'content'` — the adapter pre-loaded the file bytes on the main
 *   thread and hands them to the worker as plain serializable data. Required
 *   for adapters whose handles are not structured-clone-safe (the dev-fixture
 *   adapter, future remote/in-memory adapters).
 *
 * Both variants carry an authoritative `fileSize` (in bytes) so the indexer
 * dispatcher can enforce the platform max-file-size contract uniformly,
 * regardless of whether the file's parent folder was ever expanded in the
 * lazy file tree (and therefore had its size cached).
 */
export type FileForIndexingResolution =
  | { kind: 'handle'; fileHandle: FileSystemFileHandle; fileSize: number }
  | { kind: 'content'; content: string; fileSize: number };

/**
 * Platform-agnostic adapter contract implemented by web/electron shims.
 */
export interface FileSystemAdapter {
  /**
   * Multi-root: pick a directory and persist it as a new root with a generated
   * RootId. requestDirectoryAccess() is the legacy single-root shim over this.
   */
  addRoot?(): Promise<RootDescriptor>;
  exists(path: string): Promise<boolean>;
  /** Platform identifier for this adapter */
  readonly platform?: 'web' | 'electron';
  readDirectory(handle: DirectoryHandle, options?: DirectoryReadOptions): Promise<IFileNode[]>;
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
  readFile(handle: FileHandle): Promise<string>;
  /**
   * Read a file directly by its absolute path.
   *
   * This method is available on platforms with direct file system access (Electron)
   * and allows reading files without needing a handle from the file tree.
   * Useful for restoring persisted file tabs before the tree is loaded.
   *
   * @param absolutePath - The absolute path to the file
   * @returns The file contents as a string
   * @throws Error if the file doesn't exist or cannot be read
   */
  readFileByPath?(absolutePath: string): Promise<string>;
  /**
   * Multi-root: forget a persisted root by its RootId.
   *
   * Disconnect ≠ delete: this removes ONLY the platform persistence for the
   * root (stored handle / rootsList entry). It NEVER touches the DB — all
   * roots/file_records/file_chunks rows are deliberately KEPT so re-adding the
   * same folder resumes without re-indexing.
   */
  removeRoot?(rootId: string): Promise<void>;
  requestDirectoryAccess(): Promise<DirectoryHandle>;
  /**
   * Resolve the bytes the background token indexer needs for a given absolute
   * path. Returns either a real `FileSystemFileHandle` (preferred fast path on
   * the production web platform — the worker reads the handle in its own
   * thread) or pre-loaded UTF-8 content with byte size (used by adapters that
   * cannot produce a structured-clone-safe `FileSystemFileHandle`, e.g. the
   * in-memory dev-fixture adapter).
   *
   * Returning content keeps the worker boundary clean: the resolver does the
   * one read on the main thread and the worker hashes/counts off the
   * already-decoded string, mirroring how the Electron path pre-loads via IPC.
   *
   * Adapters that cannot serve files at all simply leave this undefined.
   * Implementations should throw on lookup failures so the indexer can park
   * the key for a later retry.
   */
  resolveFileForIndexing?(absolutePath: string): Promise<FileForIndexingResolution>;
  /**
   * Resolve a real `FileSystemFileHandle` for a given absolute path on web
   * platforms. Mirrors the segment-walk used by `readFileByPath` so callers
   * (e.g. the background token indexer) can hand a live handle off to a worker
   * without forcing the entire UI tree to expand on the main thread.
   *
   * Implementations are expected to throw a typed error (e.g. `AccessError`)
   * when the root handle is missing, the path does not point to a file, or the
   * underlying browser API rejects an intermediate segment. Callers must not
   * silently swallow these errors -- the indexer parks the failed key for a
   * later retry instead.
   *
   * Only meaningful for adapters whose handle type is the web
   * `FileSystemFileHandle`. Electron adapters intentionally leave this
   * undefined and continue using their synthetic-handle / IPC reader path.
   *
   * @param absolutePath - The absolute path (`${rootFolderId}/${relativePath}`)
   * @returns The resolved leaf `FileSystemFileHandle`
   */
  resolveFileHandleByPath?(absolutePath: string): Promise<FileSystemFileHandle>;
  restoreLastFolder?(): Promise<DirectoryHandle | null>;
  /**
   * Multi-root: return every persisted root with its current permission state.
   * Never prompts (web queryPermission only). Dead handles are returned with
   * permissionState 'unknown' — callers decide whether to surface or ignore
   * them; nothing is pruned.
   */
  restoreRoots?(): Promise<RootDescriptor[]>;
  watchDirectory?(
    handle: DirectoryHandle,
    callback: (changes: FileSystemChange[]) => void
  ): () => void;
}
