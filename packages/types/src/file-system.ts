/**
 * File system node types
 */
export type FileNodeType = 'file' | 'directory' | 'loadMore' | 'truncated';

/**
 * True for UI-only pseudo-node types ('loadMore', 'truncated') that render
 * as tree rows but never back a real file or directory. Every consumer that
 * counts files, rolls up tri-state selection, or mutates selection must
 * treat these as transparent — contributing nothing, not even an
 * "incomplete" or "unselected" signal — rather than falling through
 * whatever bucket a `!== 'directory'` / `!== 'file'` check lands them in.
 */
export function isPseudoFileNodeType(type: FileNodeType): boolean {
  return type === 'loadMore' || type === 'truncated';
}

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
  /** Browser capabilities or canonical descriptors consumed by the platform adapter. */
  handle: FileSystemFileHandle | FileSystemDirectoryHandle | FileHandle | DirectoryHandle;
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
 *   permissionState is 'granted' only while the main-process capability is
 *   mounted, and 'unknown' when a persisted root is temporarily unavailable.
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

/**
 * One entry in the DESKTOP main-process ledger of folders the user has already
 * granted this app (picker grants and successful restores). It is a grant
 * record, not a mount: an entry may be currently connected, disconnected, or
 * temporarily unavailable. It is the sole authorization source for the
 * picker-less `FileSystemAdapter.addRootByPath`.
 */
export interface RecentRootEntry {
  /** Folder basename, for display only — never an identity. */
  readonly displayName: string;
  /** Epoch ms of the most recent grant of this path. */
  readonly lastGrantedAt: number;
  /** Absolute, normalized folder path. */
  readonly path: string;
}

export interface FileHandle {
  _internal?: unknown;
  kind: 'file';
  name: string;
  path: string;
  platform: 'web' | 'electron';
  rootFolderId?: string;
  /** Durable workspace authority for desktop descriptor-relative reads. */
  rootId?: RootId;
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
   * When aborted, streaming rejects with the signal's reason and no further
   * batches are emitted. In particular, cancellation never emits a terminal
   * `done: true` batch.
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
 * A batched watcher push stamped with the watch id returned by the desktop
 * file-system capability. The payload remains platform-neutral; bridge method
 * ownership stays with the desktop application.
 */
export interface FileSystemWatchEvent {
  changes: FileSystemChange[];
  /** Bounded root-relative default-filter boundaries omitted from `changes`. */
  filteredChangeBoundaries?: readonly string[];
  /** More distinct boundaries existed than the typed protocol cap. */
  filteredChangeBoundariesOverflow?: true;
  watchId: string;
}

/** Maximum distinct filtered boundaries retained in one watcher batch. */
export const FILE_SYSTEM_WATCH_FILTERED_BOUNDARY_LIMIT = 64;

/**
 * Metadata for one filtered watcher callback.
 *
 * `filteredChangeBoundaries` contains root-relative, forward-slash paths to
 * default-filter boundaries whose detailed records were withheld. The finite
 * list lets Git consumers invalidate only intersecting registered worktrees;
 * Explorer/indexing consumers continue using only the detailed changes.
 *
 * `filteredChangeBoundariesOverflow:true` is explicit evidence that more than
 * {@link FILE_SYSTEM_WATCH_FILTERED_BOUNDARY_LIMIT} distinct boundaries were
 * observed in this batch. Git consumers fail open within the named durable
 * root. This is not watcher health/record loss and must never trigger a full
 * filesystem scan.
 */
export interface FileSystemWatchBatchMetadata {
  readonly filteredChangeBoundaries: readonly string[];
  readonly filteredChangeBoundariesOverflow?: true;
}

/**
 * Typed watcher health protocol (BST-568 slice 3).
 *
 * Engines emit `WatcherHealthTransition`s exactly once per state change; the
 * Desktop IPC layer scopes them to the owning WebContents and adds the
 * `watchId` to form the wire-level `WatcherHealthEvent`. Root paths never
 * cross renderer boundaries beyond the owner.
 */
export type WatcherHealthState = 'starting' | 'healthy' | 'degraded' | 'failed' | 'stopped';

export type WatcherBackendKind = 'fs-events' | 'inotify' | 'windows';

export interface WatcherFailure {
  /** Stable machine-readable cause, e.g. 'subscribe-timeout', 'backend-error'. */
  code: string;
  message: string;
  /** A deliberate retry may plausibly succeed (transient/runtime causes). */
  retryable: boolean;
  /**
   * The watch cannot continue in this process without intervention
   * (missing binding, unsupported platform).
   */
  terminal: boolean;
}

export interface WatcherHealthTransition {
  backend: WatcherBackendKind;
  failure?: WatcherFailure;
  state: WatcherHealthState;
  timestamp: number;
}

export interface WatcherHealthEvent extends WatcherHealthTransition {
  watchId: string;
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
  /**
   * Desktop-only: re-mount a PREVIOUSLY GRANTED folder by absolute path, with
   * no OS picker. Main's recent-roots ledger is the authorization — an unknown
   * path rejects visibly. Absent on adapters without that ledger (web); the
   * capability check IS the platform gate (never `isElectron()`).
   */
  addRootByPath?(path: string): Promise<RootDescriptor>;
  exists(path: string): Promise<boolean>;
  /**
   * Desktop-only: newest-first ledger of previously granted folders (capped in
   * main). Nothing is filtered out — currently-mounted roots are still recents,
   * and the caller owns the "already open" presentation decision.
   */
  listRecentRoots?(): Promise<readonly RecentRootEntry[]>;
  /**
   * Watcher health capability (BST-568 slice 3, desktop only today).
   * Subscribe to per-root health transitions; the adapter replays the latest
   * known state per root to a new subscriber so late-mounting UI shows
   * current status. Absent on adapters without main-process watchers — the
   * capability check IS the platform gate (never `isElectron()`).
   */
  onWatcherHealth?(callback: (event: WatcherRootHealthEvent) => void): () => void;
  /**
   * Present when the platform's own root registry records every mounted folder
   * in `roots` under its one id (desktop Main, BST-1990). Roots reconciliation
   * then only reads those records; without it (web), reconciliation writes them.
   */
  readonly ownsRootRecords?: true;
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
   * Explicit capability for reading an absolute native path without a
   * materialized file-tree handle.
   *
   * Consumers MUST pass non-empty, fully qualified absolute paths for both the
   * authoritative mounted root and requested file plus the durable RootId that
   * owns that mount, and confine the file to the root before invoking this
   * method. Registry-backed implementations must bind the RootId and claimed
   * path to the SAME live mount before reading. Implementations must reject
   * malformed arguments and independently enforce their mounted-root authority. The
   * method's presence is the capability gate;
   * `readFileByPath` alone is not evidence of absolute-path authority because
   * web adapters use it for root-relative handle resolution.
   *
   * @param absolutePath - The absolute path to the file
   * @param rootPath - The mounted absolute root containing the file
   * @param rootId - Durable identity of the mounted root
   * @returns The file contents as a string
   * @throws Error if the file doesn't exist or cannot be read
   */
  readFileByAbsolutePath?(absolutePath: string, rootPath: string, rootId: RootId): Promise<string>;
  /**
   * Read a file by an adapter-defined path. Web implementations may accept a
   * RootId-relative path and resolve a cached browser handle; desktop
   * implementations retain this method for existing IPC/import consumers.
   * Never use this method's presence as an absolute-path capability gate.
   */
  readFileByPath?(path: string): Promise<string>;
  /**
   * Multi-root: disconnect an authoritative persisted root by its RootId.
   *
   * Disconnect ≠ delete: platform authority may converge DB live status, but
   * indexed rows are deliberately retained so re-adding the same folder resumes
   * without re-indexing.
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
  /**
   * Deliberate manual retry of a failed watcher for a root previously passed
   * to `watchDirectory`. Main-process throttling applies (bounded backoff,
   * single-flight); the outcome is reported, never silently coerced.
   */
  retryWatcher?(rootPath: string): Promise<WatcherRetryOutcome>;
  /**
   * Watch a directory for changes.
   *
   * The callback's optional metadata stays on this SAME change channel.
   * `filteredChangeBoundaries` names the bounded root-relative default-filter
   * boundaries whose detailed records were withheld. Explicit boundary
   * overflow permits a Git consumer to invalidate the named root, but is not
   * watcher health and does not authorize a full filesystem scan.
   *
   * `onSignal` is the out-of-band health channel for conditions that have no
   * per-path `FileSystemChange` representation:
   * - `overflow`: the watcher may have MISSED events (WICG observer 'unknown'
   *   records). Consumers must treat the whole root as stale and run a full
   *   refresh — incremental changes alone are no longer trustworthy.
   * - `errored`: the observation is dead (WICG 'errored' record, or observe()
   *   failure after setup). The adapter has already torn the watch down; the
   *   root is UNWATCHED from this point and consumers must surface that
   *   visibly (toast/log) — never absorb it silently.
   *
   * Desktop (BST-568): the typed watcher-health protocol is the richer
   * superset; the electron renderer adapter TRANSLATES health transitions
   * into this shared channel (degraded → 'overflow', failed → 'errored') so
   * both platforms drive the same consumer plumbing, while `onWatcherHealth`
   * / `retryWatcher` add the per-root chip + deliberate-retry UX on top.
   */
  watchDirectory?(
    handle: DirectoryHandle,
    callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
    onSignal?: (signal: FileSystemWatchSignal) => void
  ): () => void;
}

/**
 * Out-of-band watcher health signal (see `FileSystemAdapter.watchDirectory`).
 * Discriminated on `type`; both variants mean "incremental change events are
 * not the full story" and require consumer action.
 */
export type FileSystemWatchSignal =
  | {
      /** Events may have been missed; the affected root needs a full refresh. */
      type: 'overflow';
    }
  | {
      /** The watch is dead and already disconnected; the root is unwatched. */
      message: string;
      type: 'errored';
    };

/** A watcher health event resolved to the renderer's own root path. */
export interface WatcherRootHealthEvent extends WatcherHealthEvent {
  rootPath: string;
}

export type WatcherRetryOutcome =
  | { retried: true }
  | {
      reason: 'in-flight' | 'not-failed' | 'terminal' | 'throttled' | 'unknown' | 'unsupported';
      retried: false;
      retryAfterMs?: number;
    };
