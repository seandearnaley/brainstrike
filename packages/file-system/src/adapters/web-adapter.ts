import type { IFileNode, RootDescriptor, RootPermissionState } from '@brainstrike/types';
import { createLogger, fileNodeCollator } from '@brainstrike/utils';
import { extractPathSegments } from '@brainstrike/utils/path-utils';
import { formatFileSize, getFileSizeConfig } from '../config';
import { AccessError } from '../errors';

const logger = createLogger('WebFileSystemAdapter');

import type {
  DirectoryHandle,
  DirectoryReadOptions,
  DirectoryStreamCallback,
  FileHandle,
  FileSystemAdapter,
  FileSystemChange,
  StreamingDirectoryReadOptions,
} from '../types';
import {
  isFileSystemDirectoryHandle,
  isFileSystemFileHandle,
  normalizeDirectoryReadOptions,
} from '../utils-browser';
import { type HandleCache, type StoredRootHandle, WebHandleCache } from './web-handle-cache';

// Type declarations for File System Access API
declare global {
  interface Window {
    showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
  }

  interface FileSystemDirectoryHandle extends FileSystemHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    getDirectoryHandle(
      name: string,
      options?: { create?: boolean }
    ): Promise<FileSystemDirectoryHandle>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
    readonly kind: 'directory';
    readonly name: string;
  }

  interface FileSystemFileHandle extends FileSystemHandle {
    getFile(): Promise<File>;
    readonly kind: 'file';
    readonly name: string;
  }

  interface FileSystemHandle {
    readonly kind: 'file' | 'directory';
    readonly name: string;
    queryPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
    requestPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
  }

  interface FileSystemPermissionDescriptor {
    mode?: 'read' | 'readwrite';
  }

  /**
   * Minimal ambient type for the WICG FileSystemObserver draft (Chrome 133+,
   * behind the File System Observer Origin Trial / experimental flag).
   * No lib.dom types exist for this API yet; these declarations mirror the
   * spec at https://github.com/WICG/file-system-observer.
   *
   * Keep in sync with the WICG draft shape; update when the API ships in
   * stable DOM typings.
   *
   * Pattern: interface (instance type) + var (constructor value) is the
   * standard TypeScript idiom for declaring a constructable global without
   * the class keyword, avoiding OXC "already declared" parse errors that
   * arise when combining `class` + `var` in the same declare-global block.
   */
  interface FileSystemObserverRecord {
    readonly changedHandle: FileSystemHandle;
    readonly relativePathComponents: readonly string[];
    /** For 'moved' records: the previous path relative to root, else null. */
    readonly relativePathMovedFrom: readonly string[] | null;
    readonly root: FileSystemDirectoryHandle;
    readonly type: 'appeared' | 'disappeared' | 'errored' | 'modified' | 'moved' | 'unknown';
  }

  type FileSystemObserverCallback = (
    records: FileSystemObserverRecord[],
    observer: FileSystemObserver
  ) => void;

  interface FileSystemObserver {
    disconnect(): void;
    observe(
      handle: FileSystemDirectoryHandle,
      options?: { recursive?: boolean }
    ): void | Promise<void>;
  }

  // Exposes the constructor as a value on globalThis for typeof feature detection.
  // This is a TypeScript ambient `var` declaration (no runtime effect — the var
  // keyword here is a TypeScript idiom for declaring a constructable global in
  // a declare-global block; it does not produce a real var statement in output).
  var FileSystemObserver: {
    new (callback: FileSystemObserverCallback): FileSystemObserver;
  };
}

// limiter shared via utils

/**
 * Create a directory node from a FileSystemDirectoryHandle.
 * Helper to reduce complexity in readDirectoryStreaming.
 */
function createDirectoryNode(
  name: string,
  parentPath: string,
  entryHandle: FileSystemDirectoryHandle,
  parentHandleName: string
): IFileNode {
  return {
    name,
    path: `${parentPath}/${name}`,
    type: 'directory',
    handle: entryHandle,
    depth: 0,
    selectionState: 'unchecked',
    children: [],
    rootFolderId: parentHandleName,
    isVisible: true,
  };
}

/**
 * Create a file node from a FileSystemFileHandle.
 * Optionally includes metadata (size, lastModified).
 * Helper to reduce complexity in readDirectoryStreaming.
 */
async function createFileNode(
  name: string,
  parentPath: string,
  fileHandle: FileSystemFileHandle,
  parentHandleName: string,
  includeMetadata: boolean
): Promise<IFileNode> {
  const baseNode: IFileNode = {
    name,
    path: `${parentPath}/${name}`,
    type: 'file',
    handle: fileHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: parentHandleName,
    isVisible: true,
  };

  if (!includeMetadata) {
    return baseNode;
  }

  try {
    const file = await fileHandle.getFile();
    return {
      ...baseNode,
      size: file.size,
      lastModified: file.lastModified,
    };
  } catch {
    // Fallback to basic node if getFile fails
    return baseNode;
  }
}

/**
 * Query the current permission state of a directory handle without prompting.
 * Uses `handle.queryPermission` if available; falls back to 'unknown'.
 * Never throws — stale/revoked handles that error during the query return 'unknown'.
 *
 * Note: web-handle-cache.ts has a private `isHandleValid` helper that also calls
 * `queryPermission`, but it is not exported. This local helper is intentionally
 * thin — it returns the raw permission value rather than a boolean so callers
 * can surface 'prompt' vs 'denied' to the UI.
 */
async function queryHandlePermission(
  handle: FileSystemDirectoryHandle
): Promise<RootPermissionState> {
  if (typeof handle.queryPermission !== 'function') {
    return 'unknown';
  }
  try {
    const state = await handle.queryPermission({ mode: 'read' });
    return state as RootPermissionState;
  } catch {
    return 'unknown';
  }
}

export interface WebFileSystemAdapterOptions {
  handleCache?: HandleCache;
}

export class WebFileSystemAdapter implements FileSystemAdapter {
  public readonly platform = 'web' as const;
  private readonly handleCache: HandleCache;
  private lastRootFolderId: string | null = null;
  private hasCheckedPersistence = false;

  constructor(options?: WebFileSystemAdapterOptions) {
    this.handleCache = options?.handleCache ?? new WebHandleCache();

    // Best-effort cleanup of stale handles on startup.
    // Runs in background without blocking initialization.
    void this.handleCache.pruneOldHandles().catch((err) => {
      logger.debug('constructor: best-effort handle pruning failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async ensurePersistentStorage(): Promise<void> {
    if (this.hasCheckedPersistence) {
      return;
    }
    this.hasCheckedPersistence = true;

    if (typeof navigator === 'undefined') {
      return;
    }
    const storage = navigator.storage;
    if (
      !(storage && typeof storage.persisted === 'function' && typeof storage.persist === 'function')
    ) {
      return;
    }

    try {
      const persisted = await storage.persisted();
      if (!persisted) {
        await storage.persist();
      }
    } catch (err) {
      logger.debug('ensurePersistentStorage: best-effort persistence request failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getHandleCache(): HandleCache {
    return this.handleCache;
  }

  private resolveRootFolderId(path: string): string | null {
    const rootFromPath = path.split('/').find((segment) => segment.length > 0) ?? null;
    if (!rootFromPath) {
      return this.lastRootFolderId;
    }

    // Web tree paths can be root-relative (`src/file.ts`) while the cached handle
    // key remains the selected root folder id (`project-root`). Preserve the active
    // root for those relative paths instead of treating the first segment as a root id.
    if (this.lastRootFolderId && rootFromPath !== this.lastRootFolderId) {
      return this.lastRootFolderId;
    }

    return rootFromPath;
  }

  private cacheFileHandleForPath(path: string, fileHandle: FileSystemFileHandle): void {
    const folderId = this.resolveRootFolderId(path);
    if (!folderId) {
      return;
    }

    void this.handleCache.storeFileHandle(folderId, path, fileHandle).catch((err) => {
      logger.debug('cacheFileHandleForPath: best-effort file handle persistence failed', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Builds a `DirectoryHandle` from a raw `FileSystemDirectoryHandle`.
   * Extracted so both `addRoot` and `restoreRoots` produce the same shape.
   */
  private toDirectoryHandle(dirHandle: FileSystemDirectoryHandle): DirectoryHandle {
    return {
      path: dirHandle.name, // Web API doesn't give full path for security
      name: dirHandle.name,
      kind: 'directory',
      platform: 'web',
      _internal: dirHandle,
    };
  }

  /**
   * Dedupe scan: find an already-stored root whose handle points at the same
   * directory as `dirHandle` (FSA `isSameEntry`). Mirrors the desktop adapter's
   * path-keyed upsert so re-picking a folder REUSES its existing RootId instead
   * of minting a new identity — a new identity would orphan the user's
   * persisted selections (folderStates are keyed by RootId) and accumulate
   * duplicate entries in the IndexedDB handle cache.
   *
   * `isSameEntry` can throw on dead/stale stored handles; a throw means "not a
   * match" and scanning continues (debug-logged, never aborts addRoot). The
   * cache read itself is also best-effort — on failure we fall back to minting
   * a fresh RootId, matching the cache layer's established best-effort
   * semantics.
   */
  private async findExistingRootId(dirHandle: FileSystemDirectoryHandle): Promise<string | null> {
    let stored: StoredRootHandle[];
    try {
      stored = await this.handleCache.getAllRootHandles();
    } catch (err) {
      logger.debug('findExistingRootId: best-effort cache scan failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    for (const record of stored) {
      try {
        if (
          typeof record.handle.isSameEntry === 'function' &&
          (await record.handle.isSameEntry(dirHandle))
        ) {
          return record.folderId;
        }
      } catch (err) {
        logger.debug('findExistingRootId: isSameEntry threw for stored handle, skipping', {
          folderId: record.folderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return null;
  }

  /**
   * Multi-root: pick a directory, persist it under a generated RootId, and
   * return a `RootDescriptor`. `requestDirectoryAccess()` is the legacy shim
   * over this method.
   *
   * Re-picking a directory that is already stored reuses its existing RootId
   * (see `findExistingRootId`) and refreshes the stored handle object; only a
   * never-before-seen directory mints a new UUID.
   */
  async addRoot(): Promise<RootDescriptor> {
    if (!('showDirectoryPicker' in window)) {
      throw new Error('File System Access API not supported');
    }
    const dirHandle = await window.showDirectoryPicker();
    const rootId = (await this.findExistingRootId(dirHandle)) ?? crypto.randomUUID();
    let persisted = true;
    try {
      await this.ensurePersistentStorage();
      await this.handleCache.storeRootHandle(rootId, dirHandle);
      logger.info('Stored root handle to IndexedDB', { name: dirHandle.name, rootId });
    } catch (err) {
      // Best-effort persistence; ignore failures (matches requestDirectoryAccess).
      // persisted:false signals that this rootId won't survive reload and must
      // not be registered in the DB.
      persisted = false;
      logger.warn('Failed to store root handle', { error: err });
    }
    this.lastRootFolderId = rootId;
    return {
      displayName: dirHandle.name,
      handle: this.toDirectoryHandle(dirHandle),
      kind: 'fsa',
      // granted implicitly by showDirectoryPicker for this session
      permissionState: 'granted',
      persisted,
      rootId,
    };
  }

  /** Legacy single-root shim: delegates to addRoot and returns only the handle. */
  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    const root = await this.addRoot();
    return root.handle;
  }

  /**
   * Multi-root: return every persisted root with its current permission state.
   * Never prompts (`queryPermission` only). Dead handles are returned with
   * permissionState 'unknown' — callers decide whether to surface or ignore
   * them; nothing is pruned.
   */
  async restoreRoots(): Promise<RootDescriptor[]> {
    const stored = await this.handleCache.getAllRootHandles();
    const descriptors: RootDescriptor[] = [];
    for (const record of stored) {
      const permissionState = await queryHandlePermission(record.handle);
      descriptors.push({
        displayName: record.name,
        handle: this.toDirectoryHandle(record.handle),
        kind: 'fsa',
        permissionState,
        // Read FROM the persistence layer, so by definition persisted.
        persisted: true,
        rootId: record.folderId,
      });
    }
    return descriptors;
  }

  async readDirectory(
    handle: DirectoryHandle,
    options?: DirectoryReadOptions
  ): Promise<IFileNode[]> {
    if (!handle.path) {
      throw new Error('Directory handle is missing its canonical path');
    }
    const dirHandle = handle._internal;
    if (!isFileSystemDirectoryHandle(dirHandle)) {
      throw new AccessError('Invalid directory handle', handle.path, 'read');
    }
    const { includeMetadata, limiter } = normalizeDirectoryReadOptions(options);

    const dirNodes: IFileNode[] = [];
    const fileWorks: Promise<IFileNode | null>[] = [];

    for await (const [name, entryHandle] of dirHandle.entries()) {
      if (entryHandle.kind === 'directory') {
        dirNodes.push({
          name,
          path: `${handle.path}/${name}`,
          type: 'directory',
          handle: entryHandle as FileSystemDirectoryHandle,
          depth: 0, // This should be calculated by the caller
          selectionState: 'unchecked',
          children: [], // Lazy loaded
          rootFolderId: handle.path,
          isVisible: true,
        });
      } else {
        const fileHandle = entryHandle as FileSystemFileHandle;
        const filePath = `${handle.path}/${name}`;
        this.cacheFileHandleForPath(filePath, fileHandle);
        if (includeMetadata) {
          fileWorks.push(
            limiter(async () => {
              try {
                const file = await fileHandle.getFile();
                return {
                  name,
                  path: filePath,
                  type: 'file',
                  handle: fileHandle,
                  depth: 0, // This should be calculated by the caller
                  selectionState: 'unchecked',
                  rootFolderId: handle.path,
                  isVisible: true,
                  size: file.size,
                  lastModified: file.lastModified,
                } satisfies IFileNode;
              } catch {
                return null;
              }
            })
          );
        } else {
          dirNodes.push({
            name,
            path: filePath,
            type: 'file',
            handle: fileHandle,
            depth: 0, // This should be calculated by the caller
            selectionState: 'unchecked',
            rootFolderId: handle.path,
            isVisible: true,
          });
        }
      }
    }

    const settled = await Promise.allSettled(fileWorks);
    const fileNodes: IFileNode[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) {
        fileNodes.push(r.value);
      }
    }

    const entries: IFileNode[] = [...dirNodes, ...fileNodes];

    return entries.sort((a, b) => {
      // Directories first, then files
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return fileNodeCollator.compare(a.name, b.name);
    });
  }

  async readFile(handle: FileHandle): Promise<string> {
    // Import config dynamically to avoid circular dependencies
    const { maxFileSize } = getFileSizeConfig();

    const fileHandle = handle._internal;
    if (!isFileSystemFileHandle(fileHandle)) {
      throw new AccessError('Invalid file handle', handle.path, 'read');
    }
    try {
      const folderId = handle.rootFolderId ?? this.lastRootFolderId;
      if (folderId) {
        await this.handleCache.storeFileHandle(folderId, handle.path, fileHandle);
      }
    } catch (err) {
      logger.debug('readFile: best-effort file handle persistence failed', {
        path: handle.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const file = await fileHandle.getFile();

    // Check file size before reading
    if (file.size > maxFileSize) {
      throw new AccessError(
        `File too large: ${formatFileSize(file.size)} (max: ${formatFileSize(maxFileSize)})`,
        handle.path,
        'read'
      );
    }

    return await file.text();
  }

  /**
   * Walk the cached root `FileSystemDirectoryHandle` for `path` and return the
   * leaf `FileSystemFileHandle`. Used by `readFileByPath` and by the background
   * token indexer (web parity with the desktop synthetic-handle path) so that
   * Select All can index files inside subfolders the user has not expanded.
   *
   * Resolved handles are cached via `WebHandleCache.storeFileHandle` on a
   * best-effort basis so subsequent reads (e.g. `readFileByPath`) can skip the
   * directory walk. Failures during the walk are propagated as typed errors
   * (`AccessError` for missing roots / non-file paths, native browser errors
   * for missing intermediate segments) so callers can park the path for retry
   * rather than silently degrading.
   */
  async resolveFileHandleByPath(path: string): Promise<FileSystemFileHandle> {
    const rootFolderId = this.resolveRootFolderId(path);
    if (!rootFolderId) {
      throw new AccessError('Root directory handle is not available', path, 'read');
    }

    const rootHandle = await this.handleCache.getRootHandle(rootFolderId);
    if (!rootHandle) {
      throw new AccessError('Root directory handle is not available', path, 'read');
    }

    const normalizedSegments = extractPathSegments(path);
    const relativeSegments =
      normalizedSegments[0] === rootFolderId ? normalizedSegments.slice(1) : normalizedSegments;

    if (relativeSegments.length === 0) {
      throw new AccessError('Path does not reference a file', path, 'read');
    }

    let currentDirectoryHandle = rootHandle;
    for (const segment of relativeSegments.slice(0, -1)) {
      currentDirectoryHandle = await currentDirectoryHandle.getDirectoryHandle(segment);
    }

    const fileName = relativeSegments.at(-1);
    if (!fileName) {
      throw new AccessError('Path does not reference a file', path, 'read');
    }

    const fileHandle = await currentDirectoryHandle.getFileHandle(fileName);
    this.cacheFileHandleForPath(path, fileHandle);
    return fileHandle;
  }

  async readFileByPath(path: string): Promise<string> {
    const fileHandle = await this.resolveFileHandleByPath(path);
    // resolveFileHandleByPath already validated the root and threw on missing
    // handles, so by this line `resolveRootFolderId(path)` cannot be undefined.
    // The non-null assertion replaces a redundant second tree walk that the
    // previous implementation did via a conditional spread.
    const rootFolderId = this.resolveRootFolderId(path) as string;
    return this.readFile({
      path,
      name: fileHandle.name,
      kind: 'file',
      platform: 'web',
      rootFolderId,
      _internal: fileHandle,
    });
  }

  /**
   * Web platform always returns a real `FileSystemFileHandle`, which is
   * structured-clone-safe and can be transferred directly to the indexer
   * worker. The thin wrapper exists so the FileSystemAdapter contract can stay
   * uniform across platforms while in-memory adapters return `kind: 'content'`.
   *
   * The resolver also queries the `File` metadata to surface an authoritative
   * `fileSize` alongside the handle. The indexer dispatcher needs the size to
   * enforce the platform's max-file-size contract uniformly — files surfaced
   * by `Select All` on unexpanded folders never had their size cached during
   * the lazy tree walk, so without this metadata round-trip an oversize file
   * would slip past the dispatch-time guard and reach the worker. `getFile()`
   * is a metadata fetch (no content read), so the cost is bounded.
   */
  async resolveFileForIndexing(
    path: string
  ): Promise<{ kind: 'handle'; fileHandle: FileSystemFileHandle; fileSize: number }> {
    const fileHandle = await this.resolveFileHandleByPath(path);
    const file = await fileHandle.getFile();
    return { kind: 'handle', fileHandle, fileSize: file.size };
  }

  async exists(_path: string): Promise<boolean> {
    // Web API doesn't provide a direct way to check existence without access
    // This would need to be implemented differently
    return false;
  }

  async restoreLastFolder(): Promise<DirectoryHandle | null> {
    logger.debug('restoreLastFolder called');
    const handles = await this.handleCache.getAllRootHandles();
    logger.debug('restoreLastFolder: found handles', { count: handles.length });
    if (handles.length === 0) {
      logger.debug('restoreLastFolder: no handles found, returning null');
      return null;
    }

    const latest = handles.reduce<StoredRootHandle | null>((current, candidate) => {
      if (!current) {
        return candidate;
      }
      return candidate.lastAccessedAt > current.lastAccessedAt ? candidate : current;
    }, null);

    if (!(latest && isFileSystemDirectoryHandle(latest.handle))) {
      if (latest) {
        await this.handleCache.removeRootHandle(latest.folderId);
      }
      return null;
    }

    let permission: PermissionState | 'unknown' = 'unknown';
    if (typeof latest.handle.queryPermission === 'function') {
      try {
        permission = await latest.handle.queryPermission({ mode: 'read' });
        logger.debug('restoreLastFolder: permission query result', { permission });
      } catch (err) {
        logger.debug('restoreLastFolder: permission query failed', { error: err });
        permission = 'unknown';
      }
    }

    if (permission !== 'granted') {
      logger.debug(
        'restoreLastFolder: permission not granted, returning null (banner should show)'
      );
      return null;
    }

    const isAccessible = await this.verifyDirectoryHandle(latest.handle);
    if (!isAccessible) {
      await this.handleCache.removeRootHandle(latest.folderId);
      return null;
    }

    this.lastRootFolderId = latest.folderId;

    return {
      path: latest.handle.name,
      name: latest.handle.name,
      kind: 'directory',
      platform: 'web',
      _internal: latest.handle,
    };
  }

  /**
   * Watch a directory for changes using the FileSystemObserver API (Chrome 133+,
   * WICG draft, feature-gated — NOT a silent fallback).
   *
   * When `typeof FileSystemObserver !== 'undefined'` (feature gate passes):
   *   - Constructs a `FileSystemObserver` with a callback that maps WICG observer
   *     records to the existing `FileSystemChange[]` shape expected by callers.
   *     `moved` records map to a removed+added pair (old path from
   *     `relativePathMovedFrom`); `errored`/`unknown` records are dropped.
   *   - Calls `observe(handle._internal, { recursive: true })`. In shipping
   *     Chrome `observe()` returns a Promise — a rejection (e.g. permission
   *     revoked asynchronously) is caught, warn-logged, and the observer is
   *     disconnected so no phantom watcher lingers behind the disposer.
   *   - Returns a disposer that calls `observer.disconnect()`.
   *
   * If `observe()` throws synchronously: logs a warn and returns a no-op
   * disposer so callers always receive a valid cleanup function. The warn is
   * intentionally visible — this is a capability failure, not a silent path.
   *
   * DESIGN: this method is ALWAYS present on the web adapter and no-ops
   * (returns a no-op disposer) when `FileSystemObserver` is unavailable. This
   * is deliberate: callers get a uniform call-site with no undefined-check.
   * Callers that need a capability signal (e.g. to surface "live re-index
   * unsupported" UI) should feature-detect `typeof FileSystemObserver`
   * themselves rather than probing for this method.
   */
  watchDirectory(
    handle: DirectoryHandle,
    callback: (changes: FileSystemChange[]) => void
  ): () => void {
    // Feature gate: FileSystemObserver is only available in Chrome 133+ with the
    // experimental flag or Origin Trial enabled. When absent, return a no-op
    // disposer — no polling, no silent fallback, callers should treat the folder
    // as unwatched.
    if (typeof FileSystemObserver === 'undefined') {
      return () => {};
    }

    const observer = new FileSystemObserver((records) => {
      const changes: FileSystemChange[] = records.flatMap((r): FileSystemChange[] => {
        // Build a path by joining the root handle path with the relative components.
        const relPath = r.relativePathComponents.join('/');
        const fullPath = relPath ? `${handle.path}/${relPath}` : handle.path;
        const kind: FileSystemChange['kind'] =
          r.changedHandle.kind === 'directory' ? 'directory' : 'file';

        switch (r.type) {
          case 'appeared':
            return [{ type: 'added', path: fullPath, kind }];
          case 'disappeared':
            return [{ type: 'removed', path: fullPath, kind }];
          case 'modified':
            return [{ type: 'modified', path: fullPath, kind }];
          case 'moved': {
            // A rename is a removed+added pair so consumers re-index both the
            // vacated and the new path. When the observer didn't report the
            // old location (null/empty relativePathMovedFrom), emit only the
            // added event — there is no old path to invalidate.
            const movedFrom = r.relativePathMovedFrom;
            if (movedFrom && movedFrom.length > 0) {
              const oldFullPath = `${handle.path}/${movedFrom.join('/')}`;
              return [
                { type: 'removed', path: oldFullPath, kind },
                { type: 'added', path: fullPath, kind },
              ];
            }
            return [{ type: 'added', path: fullPath, kind }];
          }
          default:
            // 'errored' and 'unknown' have no FileSystemChange equivalent;
            // errored conditions are surfaced via the observe() rejection
            // handler below, not as change events.
            return [];
        }
      });

      if (changes.length > 0) {
        callback(changes);
      }
    });

    const internalHandle = handle._internal;
    if (!(internalHandle instanceof Object)) {
      logger.warn('watchDirectory: handle._internal is not a valid FileSystemDirectoryHandle', {
        path: handle.path,
      });
      return () => {};
    }

    try {
      // MDN/shipping Chrome define observe() as Promise-returning. A rejection
      // (e.g. permission revoked after setup) means observation never started:
      // warn visibly and disconnect so the disposer isn't holding a phantom
      // watcher. The sync try/catch still covers engines/stubs that throw.
      const observeResult = observer.observe(internalHandle as FileSystemDirectoryHandle, {
        recursive: true,
      });
      if (observeResult instanceof Promise) {
        observeResult.catch((err: unknown) => {
          logger.warn(
            'watchDirectory: FileSystemObserver.observe() rejected, folder is unwatched',
            {
              path: handle.path,
              error: err instanceof Error ? err.message : String(err),
            }
          );
          observer.disconnect();
        });
      }
    } catch (err) {
      // Permission revoked or handle invalid: log a visible warn and return a
      // no-op disposer. This is a capability failure — it must not be silent.
      logger.warn('watchDirectory: FileSystemObserver.observe() threw, folder is unwatched', {
        path: handle.path,
        error: err instanceof Error ? err.message : String(err),
      });
      return () => {};
    }

    return () => {
      observer.disconnect();
    };
  }

  /**
   * Stream directory contents with batched callbacks (BST-147).
   *
   * Uses the Web File System Access API's async iterator to stream entries,
   * calling onBatch with groups of entries as they're discovered.
   *
   * @param handle - Directory to enumerate
   * @param onBatch - Called with each batch of entries; meta.done indicates final batch
   * @param options - Streaming options including batchSize and AbortSignal
   */
  async readDirectoryStreaming(
    handle: DirectoryHandle,
    onBatch: DirectoryStreamCallback,
    options?: StreamingDirectoryReadOptions
  ): Promise<void> {
    const dirHandle = handle._internal;
    if (!isFileSystemDirectoryHandle(dirHandle)) {
      throw new AccessError('Invalid directory handle', handle.path, 'read');
    }

    const batchSize = options?.batchSize ?? 50;
    const signal = options?.signal;
    const { includeMetadata } = normalizeDirectoryReadOptions(options);

    let batch: IFileNode[] = [];
    let total = 0;

    for await (const [name, entryHandle] of dirHandle.entries()) {
      // Check for cancellation
      if (signal?.aborted) {
        break;
      }

      // Create node using extracted helper functions
      const node =
        entryHandle.kind === 'directory'
          ? createDirectoryNode(
              name,
              handle.path,
              entryHandle as FileSystemDirectoryHandle,
              handle.name
            )
          : await createFileNode(
              name,
              handle.path,
              entryHandle as FileSystemFileHandle,
              handle.name,
              includeMetadata
            );

      if (entryHandle.kind === 'file') {
        this.cacheFileHandleForPath(node.path, entryHandle as FileSystemFileHandle);
      }

      batch.push(node);
      total++;

      // Emit batch when full
      if (batch.length >= batchSize) {
        onBatch(batch, { done: false, total });
        batch = [];
      }
    }

    // Emit any remaining entries
    if (batch.length > 0 || total === 0) {
      onBatch(batch, { done: true, total });
    } else {
      // Signal completion with empty batch if last batch was exactly full
      onBatch([], { done: true, total });
    }
  }

  private async verifyDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<boolean> {
    try {
      const iterator = handle.entries();
      await iterator.next();
      return true;
    } catch {
      return false;
    }
  }
}
