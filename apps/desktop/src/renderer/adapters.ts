import type { DirectoryHandle, FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { StorageAdapter } from '@brainstrike/storage';
import type {
  ElectronAPI,
  FileSystemChange,
  FileSystemWatchEvent,
  IFileNode,
  RootDescriptor,
  WatcherHealthEvent,
  WatcherRetryOutcome,
  WatcherRootHealthEvent,
} from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('ElectronRendererAdapters');

function requireElectronAPI(): ElectronAPI {
  const api = window.electronAPI;
  if (!api) {
    throw new Error('Electron API is not available in the renderer process');
  }
  return api;
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
const watchCallbacksById = new Map<string, (changes: FileSystemChange[]) => void>();
let sharedWatchUnsubscribe: (() => void) | null = null;

function ensureSharedWatchSubscription(
  onWatchEvent: (callback: (event: FileSystemWatchEvent) => void) => () => void
): void {
  if (sharedWatchUnsubscribe) {
    return;
  }
  sharedWatchUnsubscribe = onWatchEvent((event) => {
    const callback = watchCallbacksById.get(event.watchId);
    if (callback && event.changes.length > 0) {
      callback(event.changes);
    }
  });
}

function registerWatchCallback(
  onWatchEvent: (callback: (event: FileSystemWatchEvent) => void) => () => void,
  watchId: string,
  callback: (changes: FileSystemChange[]) => void
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
const healthSubscribers = new Set<(event: WatcherRootHealthEvent) => void>();
let sharedHealthUnsubscribe: (() => void) | null = null;

function ensureSharedHealthSubscription(
  onWatchHealth: (callback: (event: WatcherHealthEvent) => void) => () => void
): void {
  if (sharedHealthUnsubscribe) {
    return;
  }
  sharedHealthUnsubscribe = onWatchHealth((event) => {
    const rootPath = rootPathByWatchId.get(event.watchId);
    if (!rootPath) {
      return;
    }
    const resolved: WatcherRootHealthEvent = { ...event, rootPath };
    latestHealthByRootPath.set(rootPath, resolved);
    for (const subscriber of Array.from(healthSubscribers)) {
      subscriber(resolved);
    }
  });
}

function forgetWatchHealth(watchId: string): void {
  const rootPath = rootPathByWatchId.get(watchId);
  rootPathByWatchId.delete(watchId);
  if (rootPath) {
    latestHealthByRootPath.delete(rootPath);
  }
  if (rootPathByWatchId.size === 0 && sharedHealthUnsubscribe) {
    sharedHealthUnsubscribe();
    sharedHealthUnsubscribe = null;
  }
}

/** Test-only: reset the module-level shared dispatcher between test cases. */
export function __resetFsWatchDispatcherForTest(): void {
  watchCallbacksById.clear();
  sharedWatchUnsubscribe = null;
  rootPathByWatchId.clear();
  latestHealthByRootPath.clear();
  healthSubscribers.clear();
  sharedHealthUnsubscribe = null;
}

export class ElectronRendererFileSystemAdapter implements FileSystemAdapter {
  public readonly platform = 'electron' as const;

  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    const api = requireElectronAPI().fileSystem;
    const handle = await api.requestDirectoryAccess();

    // Save the selected folder path for future auto-restore
    if (handle?.path) {
      await api.saveLastFolder(handle.path);
    }
    return handle;
  }

  async addRoot(): Promise<RootDescriptor> {
    return requireElectronAPI().fileSystem.addRoot();
  }

  async restoreRoots(): Promise<RootDescriptor[]> {
    return requireElectronAPI().fileSystem.restoreRoots();
  }

  /**
   * Disconnect a root by RootId. Disconnect ≠ delete — only the persisted
   * rootsList entry (and a matching lastFolderPath) is forgotten; DB rows are
   * deliberately KEPT so re-adding the same folder resumes without re-indexing.
   */
  async removeRoot(rootId: string): Promise<void> {
    return requireElectronAPI().fileSystem.removeRoot(rootId);
  }

  async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
    return requireElectronAPI().fileSystem.readDirectory(handle);
  }

  async readFile(handle: FileHandle): Promise<string> {
    return requireElectronAPI().fileSystem.readFile(handle);
  }

  /**
   * Read a file directly by its absolute path.
   * BST-307: Enables loading persisted file tabs before the file tree is available.
   */
  async readFileByPath(absolutePath: string): Promise<string> {
    return requireElectronAPI().fileSystem.readFileByPath(absolutePath);
  }

  async exists(path: string): Promise<boolean> {
    return requireElectronAPI().fileSystem.exists(path);
  }

  async restoreLastFolder(): Promise<DirectoryHandle | null> {
    return requireElectronAPI().fileSystem.restoreLastFolder();
  }

  /**
   * Watch a directory via the main-process watcher bridge (fs:watch →
   * chokidar in main → fs:watch-event pushes → callback).
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
    callback: (changes: FileSystemChange[]) => void
  ): () => void {
    const api = window.electronAPI?.fileSystem;
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
      .then(({ watchId: id }) => {
        if (closed) {
          stopMainWatcher(id);
          return;
        }
        watchId = id;
        // Route pushes for this id through the shared dispatcher (one bridge
        // subscription total, regardless of how many roots are watched).
        registerWatchCallback(api.onWatchEvent, id, callback);
        // Health capability (older bridges may lack it — visibly absent).
        if (typeof api.onWatchHealth === 'function') {
          rootPathByWatchId.set(id, handle.path);
          ensureSharedHealthSubscription(api.onWatchHealth);
        }
      })
      .catch((error: unknown) => {
        // Visible capability failure (invalid path, watcher setup error) —
        // the folder stays unwatched, never a silent fallback.
        logger.warn('watchDirectory: failed to start main-process watcher; folder is unwatched', {
          error: error instanceof Error ? error.message : String(error),
          path: handle.path,
        });
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
    const api = window.electronAPI?.fileSystem;
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
    return requireElectronAPI().storage.getItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    return requireElectronAPI().storage.setItem(key, value);
  }

  async removeItem(key: string): Promise<void> {
    return requireElectronAPI().storage.removeItem(key);
  }

  async clear(): Promise<void> {
    return requireElectronAPI().storage.clear();
  }

  async getAllKeys(): Promise<string[]> {
    return requireElectronAPI().storage.getAllKeys();
  }
}
