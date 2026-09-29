import {
  type DirectoryHandle,
  type FileHandle,
  type FileSystemAdapter,
  isDurableRootId,
  isFullyQualifiedFileSystemPath,
} from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import type { StorageAdapter } from '@brainstrike/storage';
import type {
  FileSystemChange,
  FileSystemWatchBatchMetadata,
  FileSystemWatchEvent,
  FileSystemWatchSignal,
  IFileNode,
  RecentRootEntry,
  RootDescriptor,
  WatcherHealthEvent,
  WatcherRetryOutcome,
  WatcherRootHealthEvent,
} from '@brainstrike/types';
import type { DesktopFileSystemBridge, DesktopStorageBridge } from '../types/desktop-electron-api';

const logger = createLogger('ElectronRendererAdapters');

function assertExplicitAbsoluteReadPath(value: unknown, label: string): asserts value is string {
  if (isFullyQualifiedFileSystemPath(value)) {
    return;
  }
  throw new Error(`${label} must be a non-empty absolute path`);
}

function getFileSystemBridge(): DesktopFileSystemBridge | undefined {
  const api = window.electronAPI;
  return api && 'fileSystem' in api ? api.fileSystem : undefined;
}

function requireFileSystemBridge(): DesktopFileSystemBridge {
  const fileSystem = getFileSystemBridge();
  if (!fileSystem) {
    throw new Error('The desktop file-system capability is not available in this renderer role');
  }
  return fileSystem;
}

function requireStorageBridge(): DesktopStorageBridge {
  const api = window.electronAPI;
  if (!(api && 'storage' in api)) {
    throw new Error('The desktop storage capability is not available in this renderer role');
  }
  return api.storage;
}

/**
 * Shared fs:watch-event dispatcher. Every `watchDirectory` call funnels through
 * ONE `onWatchEvent` bridge subscription that fans out to per-watch callbacks
 * keyed by `watchId`. Registering a listener per watch instead would put
 * O(roots) listeners on the single IPC channel — a forest with >10 mounted
 * roots trips Node's MaxListenersExceededWarning in the renderer and makes
 * every push O(roots) to filter. The shared subscription is created lazily on
 * the first registration and torn down when the last watch unregisters.
 */
const watchCallbacksById = new Map<
  string,
  (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void
>();
let sharedWatchUnsubscribe: (() => void) | null = null;

function ensureSharedWatchSubscription(
  onWatchEvent: (callback: (event: FileSystemWatchEvent) => void) => () => void
): void {
  if (sharedWatchUnsubscribe) {
    return;
  }
  sharedWatchUnsubscribe = onWatchEvent((event) => {
    const callback = watchCallbacksById.get(event.watchId);
    if (!callback) {
      return;
    }
    if (event.filteredChangeBoundaries && event.filteredChangeBoundaries.length > 0) {
      callback(event.changes, {
        filteredChangeBoundaries: event.filteredChangeBoundaries,
        ...(event.filteredChangeBoundariesOverflow === true
          ? { filteredChangeBoundariesOverflow: true }
          : {}),
      });
    } else if (event.changes.length > 0) {
      callback(event.changes);
    }
  });
}

function registerWatchCallback(
  onWatchEvent: (callback: (event: FileSystemWatchEvent) => void) => () => void,
  watchId: string,
  callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void
): void {
  ensureSharedWatchSubscription(onWatchEvent);
  watchCallbacksById.set(watchId, callback);
}

function unregisterWatchCallback(watchId: string): void {
  watchCallbacksById.delete(watchId);
  if (watchCallbacksById.size === 0 && sharedWatchUnsubscribe) {
    sharedWatchUnsubscribe();
    sharedWatchUnsubscribe = null;
  }
}

/**
 * Watcher health dispatcher (BST-568 slice 3). Mirrors the change dispatcher:
 * ONE bridge fs:watch-health subscription total, fan-out to renderer
 * subscribers. This renderer resolves watchIds back to the root paths of the
 * watches IT created (paths never cross to other renderers), and retains the
 * latest transition per root so late-mounting UI sees current status.
 */
const rootPathByWatchId = new Map<string, string>();
const latestHealthByRootPath = new Map<string, WatcherRootHealthEvent>();
const earlyHealthByWatchId = new Map<string, WatcherHealthEvent>();
const healthSubscribers = new Set<(event: WatcherRootHealthEvent) => void>();
// Per-watch translation of health transitions into the SHARED
// FileSystemWatchSignal channel (#1764): degraded -> 'overflow' (events may
// have been missed; consumers full-refresh the root), failed -> 'errored'
// (the watch is dead; consumers surface it visibly). This is what plugs
// desktop into the same consumer plumbing the web adapter drives.
const signalCallbacksById = new Map<string, (signal: FileSystemWatchSignal) => void>();
let sharedHealthUnsubscribe: (() => void) | null = null;
let pendingHealthWatchStarts = 0;

function tearDownSharedHealthSubscriptionIfIdle(): void {
  if (rootPathByWatchId.size > 0 || pendingHealthWatchStarts > 0 || !sharedHealthUnsubscribe) {
    return;
  }
  earlyHealthByWatchId.clear();
  sharedHealthUnsubscribe();
  sharedHealthUnsubscribe = null;
}

/**
 * Fan a resolved transition out to the health subscribers AND the per-watch
 * FileSystemWatchSignal callback. Shared by the live push path and the
 * snapshot-on-response path so both behave identically.
 */
function dispatchHealth(event: WatcherRootHealthEvent): void {
  latestHealthByRootPath.set(event.rootPath, event);
  for (const subscriber of Array.from(healthSubscribers)) {
    subscriber(event);
  }
  const signalCallback = signalCallbacksById.get(event.watchId);
  if (!signalCallback) {
    return;
  }
  if (event.state === 'degraded') {
    signalCallback({ type: 'overflow' });
  } else if (event.state === 'failed') {
    signalCallback({
      message: event.failure?.message ?? 'watcher failed',
      type: 'errored',
    });
  }
}

function ensureSharedHealthSubscription(
  onWatchHealth: (callback: (event: WatcherHealthEvent) => void) => () => void
): void {
  if (sharedHealthUnsubscribe) {
    return;
  }
  sharedHealthUnsubscribe = onWatchHealth((event) => {
    const rootPath = rootPathByWatchId.get(event.watchId);
    if (!rootPath) {
      if (pendingHealthWatchStarts > 0) {
        earlyHealthByWatchId.set(event.watchId, event);
      }
      return;
    }
    dispatchHealth({ ...event, rootPath });
  });
}

function forgetWatchHealth(watchId: string): void {
  signalCallbacksById.delete(watchId);
  const rootPath = rootPathByWatchId.get(watchId);
  rootPathByWatchId.delete(watchId);
  if (rootPath) {
    latestHealthByRootPath.delete(rootPath);
  }
  earlyHealthByWatchId.delete(watchId);
  tearDownSharedHealthSubscriptionIfIdle();
}

/** Test-only: reset the module-level shared dispatcher between test cases. */
export function __resetFsWatchDispatcherForTest(): void {
  watchCallbacksById.clear();
  sharedWatchUnsubscribe = null;
  rootPathByWatchId.clear();
  latestHealthByRootPath.clear();
  earlyHealthByWatchId.clear();
  healthSubscribers.clear();
  signalCallbacksById.clear();
  sharedHealthUnsubscribe = null;
  pendingHealthWatchStarts = 0;
}

export class ElectronRendererFileSystemAdapter implements FileSystemAdapter {
  public readonly platform = 'electron' as const;

  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    // Main owns the last-folder preference: fs:requestDirectoryAccess routes
    // through the registry's addRoot, which persists it on success.
    return requireFileSystemBridge().requestDirectoryAccess();
  }

  async addRoot(): Promise<RootDescriptor> {
    return requireFileSystemBridge().addRoot();
  }

  /**
   * Desktop-only capability (web omits it rather than stubbing): re-mount a
   * folder main's recent-roots ledger already records as granted. Main rejects
   * anything else — this is not a general open-any-path door.
   */
  async addRootByPath(rootPath: string): Promise<RootDescriptor> {
    return requireFileSystemBridge().addRootByPath(rootPath);
  }

  async listRecentRoots(): Promise<readonly RecentRootEntry[]> {
    return requireFileSystemBridge().listRecentRoots();
  }

  async restoreRoots(): Promise<RootDescriptor[]> {
    return requireFileSystemBridge().restoreRoots();
  }

  /**
   * Disconnect a root by RootId. Main owns the authoritative transition:
   * persistence and DB live-status converge together, while indexed rows remain
   * retained so re-adding the folder resumes without re-indexing.
   */
  async removeRoot(rootId: string): Promise<void> {
    return requireFileSystemBridge().removeRoot(rootId);
  }

  async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
    return requireFileSystemBridge().readDirectory(handle);
  }

  async readFile(handle: FileHandle): Promise<string> {
    return requireFileSystemBridge().readFile(handle);
  }

  /**
   * Read by absolute path within a currently mounted root. This enables loading
   * persisted tabs before their tree nodes exist without granting rootless disk
   * access.
   */
  async readFileByPath(absolutePath: string): Promise<string> {
    return requireFileSystemBridge().readFileByPath(absolutePath);
  }

  /**
   * Explicit absolute-path capability. The renderer confines the path to
   * `rootPath`; main exact-binds `rootId` and that path against the mounted
   * registry before authorizing the file.
   */
  async readFileByAbsolutePath(
    absolutePath: string,
    rootPath: string,
    rootId: string
  ): Promise<string> {
    assertExplicitAbsoluteReadPath(rootPath, 'Mounted root path');
    assertExplicitAbsoluteReadPath(absolutePath, 'Requested file path');
    if (!isDurableRootId(rootId)) {
      throw new Error('Mounted root identity must be a durable rootId');
    }
    return requireFileSystemBridge().readFileByAbsolutePath(absolutePath, rootPath, rootId);
  }

  async exists(path: string): Promise<boolean> {
    return requireFileSystemBridge().exists(path);
  }

  async restoreLastFolder(): Promise<DirectoryHandle | null> {
    return requireFileSystemBridge().restoreLastFolder();
  }

  /**
   * Watch a directory via the main-process watcher bridge (fs:watch →
   * @parcel/watcher in main → fs:watch-event pushes → callback).
   *
   * Capability-gated, mirroring the web adapter's FileSystemObserver gate:
   * when the preload bridge lacks the watch methods (older build), this
   * warn-logs and returns a no-op disposer — the folder is visibly unwatched,
   * never silently polled.
   *
   * The returned disposer is synchronous while the watch start is async; a
   * `closed` flag bridges the gap so disposing before the watchId arrives
   * still unwatches once it does (no orphaned main-process watcher).
   */
  watchDirectory(
    handle: DirectoryHandle,
    callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
    onSignal?: (signal: FileSystemWatchSignal) => void
  ): () => void {
    const api = getFileSystemBridge();
    if (
      !api ||
      typeof api.watchDirectory !== 'function' ||
      typeof api.unwatchDirectory !== 'function' ||
      typeof api.onWatchEvent !== 'function'
    ) {
      logger.warn(
        'watchDirectory: desktop bridge lacks the fs watch capability; folder is unwatched',
        { path: handle.path }
      );
      return () => {};
    }

    let closed = false;
    let watchId: string | null = null;
    const supportsHealth = typeof api.onWatchHealth === 'function';
    if (supportsHealth) {
      pendingHealthWatchStarts += 1;
      ensureSharedHealthSubscription(api.onWatchHealth);
    }

    const stopMainWatcher = (id: string): void => {
      api.unwatchDirectory(id).catch((error: unknown) => {
        logger.warn('watchDirectory: failed to stop main-process watcher', {
          error: error instanceof Error ? error.message : String(error),
          watchId: id,
        });
      });
    };

    api
      .watchDirectory(handle)
      .then(({ health, watchId: id }) => {
        if (closed) {
          earlyHealthByWatchId.delete(id);
          stopMainWatcher(id);
          return;
        }
        watchId = id;
        // Route pushes for this id through the shared dispatcher (one bridge
        // subscription total, regardless of how many roots are watched).
        registerWatchCallback(api.onWatchEvent, id, callback);
        // Health capability (older bridges may lack it — visibly absent).
        if (!supportsHealth) {
          return;
        }
        rootPathByWatchId.set(id, handle.path);
        if (onSignal) {
          signalCallbacksById.set(id, onSignal);
        }
        const earlyHealth = earlyHealthByWatchId.get(id);
        earlyHealthByWatchId.delete(id);
        const initialHealth =
          earlyHealth && (!health || earlyHealth.timestamp >= health.timestamp)
            ? earlyHealth
            : health;
        if (initialHealth) {
          dispatchHealth({ ...initialHealth, rootPath: handle.path, watchId: id });
        }
      })
      .catch((error: unknown) => {
        // Visible capability failure (invalid path, watcher setup error) —
        // the folder stays unwatched, never a silent fallback.
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('watchDirectory: failed to start main-process watcher; folder is unwatched', {
          error: message,
          path: handle.path,
        });
        // A rejection means there is no watchId and no health snapshot, so
        // NEITHER of the health paths above can report this. Console-only would
        // leave the root silently unwatched — drive the shared signal channel
        // directly, matching how the web adapter treats a failed observe().
        onSignal?.({
          message: `File watching could not start for ${handle.path}: ${message}`,
          type: 'errored',
        });
      })
      .finally(() => {
        if (!supportsHealth) {
          return;
        }
        pendingHealthWatchStarts -= 1;
        if (pendingHealthWatchStarts === 0) {
          earlyHealthByWatchId.clear();
        }
        tearDownSharedHealthSubscriptionIfIdle();
      });

    return () => {
      if (closed) {
        return;
      }
      closed = true;
      if (watchId !== null) {
        unregisterWatchCallback(watchId);
        forgetWatchHealth(watchId);
        stopMainWatcher(watchId);
        watchId = null;
      }
    };
  }

  /**
   * Watcher health capability (BST-568 slice 3). Replays the latest known
   * state per root to the new subscriber, then streams live transitions.
   * Renders nothing on older bridges without fs:watch-health — the folder's
   * health is visibly unknown, never faked.
   */
  onWatcherHealth(callback: (event: WatcherRootHealthEvent) => void): () => void {
    for (const event of latestHealthByRootPath.values()) {
      callback(event);
    }
    healthSubscribers.add(callback);
    return () => {
      healthSubscribers.delete(callback);
    };
  }

  /** Deliberate manual retry of a failed watcher for a watched root path. */
  async retryWatcher(rootPath: string): Promise<WatcherRetryOutcome> {
    const api = getFileSystemBridge();
    if (!api || typeof api.retryWatch !== 'function') {
      return { reason: 'unsupported', retried: false };
    }
    let watchId: string | null = null;
    for (const [id, path] of rootPathByWatchId) {
      if (path === rootPath) {
        watchId = id;
        break;
      }
    }
    if (!watchId) {
      return { reason: 'unknown', retried: false };
    }
    return await api.retryWatch(watchId);
  }
}

export class ElectronRendererStorageAdapter implements StorageAdapter {
  async getItem(key: string): Promise<string | null> {
    return requireStorageBridge().getItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    return requireStorageBridge().setItem(key, value);
  }

  async removeItem(key: string): Promise<void> {
    return requireStorageBridge().removeItem(key);
  }

  async clear(): Promise<void> {
    return requireStorageBridge().clear();
  }

  async getAllKeys(): Promise<string[]> {
    return requireStorageBridge().getAllKeys();
  }
}
