import type { HostClient } from '@brainstrike/agent-host/browser';
import type { WorkspaceFilesEvent } from '@brainstrike/agent-host/protocol';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import type {
  FileSystemChange,
  FileSystemWatchBatchMetadata,
  FileSystemWatchSignal,
  WatcherHealthTransition,
  WatcherRetryOutcome,
  WatcherRootHealthEvent,
} from '@brainstrike/types';
import { type DesktopHostConnection, windowHostConnection } from './desktop-host-connection';

const logger = createLogger('DesktopFileWatches');

type HealthEvent = Extract<WorkspaceFilesEvent, { readonly type: 'health' }>;
type ChangesEvent = Extract<WorkspaceFilesEvent, { readonly type: 'changes' }>;
const HOST_ENDED_MESSAGE = 'File watching stopped because the agent host ended.';

/** The Explorer's watch capability, as the desktop file-system adapter exposes it. */
export interface DesktopFileWatches {
  onWatcherHealth(callback: (event: WatcherRootHealthEvent) => void): () => void;
  retryWatcher(rootPath: string): Promise<WatcherRetryOutcome>;
  watchDirectory(
    handle: DirectoryHandle,
    callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
    onSignal?: (signal: FileSystemWatchSignal) => void
  ): () => void;
}

interface Watch {
  readonly callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void;
  closed: boolean;
  readonly handle: DirectoryHandle;
  /** The host that holds this watch; absent while it starts or after that host ended. */
  host: HostClient | undefined;
  /** The latest transition its host reported. */
  lastHealth: WatcherHealthTransition | undefined;
  readonly onSignal: ((signal: FileSystemWatchSignal) => void) | undefined;
  watchId: string | undefined;
}

/** A batch with its withheld boundaries; an empty batch with none says nothing. */
function deliverChanges(watch: Watch, event: ChangesEvent): void {
  if (event.filteredChangeBoundaries && event.filteredChangeBoundaries.length > 0) {
    watch.callback(event.changes, {
      filteredChangeBoundaries: event.filteredChangeBoundaries,
      ...(event.filteredChangeBoundariesOverflow === true
        ? { filteredChangeBoundariesOverflow: true }
        : {}),
    });
  } else if (event.changes.length > 0) {
    watch.callback(event.changes);
  }
}

/** A watch whose host ended has no producer left; a deliberate retry starts it on the next host. */
function hostEnded(last: WatcherHealthTransition): WatcherHealthTransition {
  return {
    backend: last.backend,
    failure: {
      code: 'host-ended',
      message: HOST_ENDED_MESSAGE,
      retryable: true,
      terminal: false,
    },
    state: 'failed',
    timestamp: Date.now(),
  };
}

/**
 * ADR-0029 stage 4: the Explorer's root watches live in the agent host. Each
 * watch is held on this frame's host connection; batches and health arrive on
 * its `workspace/files/event` stream. A host that ends takes its watches with
 * it, which each watch reports as a retryable failure.
 */
export function createDesktopFileWatches(connection: DesktopHostConnection): DesktopFileWatches {
  const watches = new Set<Watch>();
  const byId = new Map<string, Watch>();
  const attached = new WeakSet<HostClient>();
  const latestHealthByRootPath = new Map<string, WatcherRootHealthEvent>();
  const healthSubscribers = new Set<(event: WatcherRootHealthEvent) => void>();
  // Health the host pushed while a watch was starting, before its id was known.
  const earlyHealth = new Map<string, HealthEvent>();
  let starting = 0;

  const dispatchHealth = (
    watch: Watch,
    watchId: string,
    transition: WatcherHealthTransition
  ): void => {
    watch.lastHealth = transition;
    const event: WatcherRootHealthEvent = { ...transition, rootPath: watch.handle.path, watchId };
    latestHealthByRootPath.set(event.rootPath, event);
    for (const subscriber of [...healthSubscribers]) {
      subscriber(event);
    }
    if (transition.state === 'degraded') {
      watch.onSignal?.({ type: 'overflow' });
    } else if (transition.state === 'failed') {
      watch.onSignal?.({
        message: transition.failure?.message ?? 'watcher failed',
        type: 'errored',
      });
    }
  };

  const receive = (event: WorkspaceFilesEvent): void => {
    const watch = byId.get(event.watchId);
    if (event.type === 'changes') {
      if (watch && !watch.closed) {
        deliverChanges(watch, event);
      }
      return;
    }
    if (!watch) {
      if (starting > 0) {
        earlyHealth.set(event.watchId, event);
      }
      return;
    }
    const { type: _type, watchId, ...transition } = event;
    dispatchHealth(watch, watchId, transition);
  };

  const attach = (host: HostClient): void => {
    if (attached.has(host)) {
      return;
    }
    attached.add(host);
    host.onWorkspaceFiles(receive);
    const lost = (): void => {
      // The frame closed its own connection: it is unloading, and its watches with it.
      if (connection.getSnapshot().kind === 'closed') {
        return;
      }
      for (const watch of watches) {
        if (watch.host !== host || watch.watchId === undefined) {
          continue;
        }
        const watchId = watch.watchId;
        byId.delete(watchId);
        watch.host = undefined;
        watch.watchId = undefined;
        const ended = watch.lastHealth ? hostEnded(watch.lastHealth) : undefined;
        if (ended) {
          dispatchHealth(watch, watchId, ended);
        } else {
          watch.onSignal?.({ message: HOST_ENDED_MESSAGE, type: 'errored' });
        }
      }
    };
    void host.closed.then(lost, lost);
  };

  const unwatch = (host: HostClient, watchId: string): void => {
    host.request('workspace/files/unwatch', { watchId }).catch((error: unknown) => {
      logger.warn('Could not stop a file watch', {
        error: error instanceof Error ? error.message : String(error),
        watchId,
      });
    });
  };

  /** Starts `watch` on the current host; a failure is the watch's errored signal. */
  const start = async (watch: Watch): Promise<void> => {
    starting += 1;
    try {
      const host = await connection.current();
      attach(host);
      const { health, watchId } = await host.request('workspace/files/watch', {
        path: watch.handle.path,
      });
      if (watch.closed) {
        unwatch(host, watchId);
        return;
      }
      watch.host = host;
      watch.watchId = watchId;
      byId.set(watchId, watch);
      const early = earlyHealth.get(watchId);
      earlyHealth.delete(watchId);
      const initial =
        early && (!health || early.timestamp >= health.timestamp)
          ? (({ type: _type, watchId: _id, ...transition }) => transition)(early)
          : health;
      if (initial) {
        dispatchHealth(watch, watchId, initial);
      }
    } catch (error) {
      // A disposed watch, or a frame unloading with its connection, has no one to tell.
      if (watch.closed || connection.getSnapshot().kind === 'closed') {
        return;
      }
      // Visible failure (unknown root, unavailable folder, no host): the folder
      // stays unwatched, never polled.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('File watching could not start; folder is unwatched', {
        error: message,
        path: watch.handle.path,
      });
      watch.onSignal?.({
        message: `File watching could not start for ${watch.handle.path}: ${message}`,
        type: 'errored',
      });
    } finally {
      starting -= 1;
      if (starting === 0) {
        earlyHealth.clear();
      }
    }
  };

  return {
    onWatcherHealth: (callback) => {
      for (const event of latestHealthByRootPath.values()) {
        callback(event);
      }
      healthSubscribers.add(callback);
      return () => {
        healthSubscribers.delete(callback);
      };
    },
    retryWatcher: async (rootPath) => {
      const watch = [...watches].find((candidate) => candidate.handle.path === rootPath);
      if (!watch) {
        return { reason: 'unknown', retried: false };
      }
      if (watch.host && watch.watchId) {
        return await watch.host.request('workspace/files/watch-retry', { watchId: watch.watchId });
      }
      await start(watch);
      return watch.watchId ? { retried: true } : { reason: 'unknown', retried: false };
    },
    watchDirectory: (handle, callback, onSignal) => {
      const watch: Watch = {
        callback,
        closed: false,
        handle,
        host: undefined,
        lastHealth: undefined,
        onSignal,
        watchId: undefined,
      };
      watches.add(watch);
      void start(watch);
      return () => {
        if (watch.closed) {
          return;
        }
        watch.closed = true;
        watches.delete(watch);
        if (latestHealthByRootPath.get(handle.path)?.watchId === watch.watchId) {
          latestHealthByRootPath.delete(handle.path);
        }
        if (watch.host && watch.watchId) {
          byId.delete(watch.watchId);
          unwatch(watch.host, watch.watchId);
        }
      };
    },
  };
}

let windowWatches: DesktopFileWatches | undefined;

/** `null` where this window has no agent-host capability. */
export function resolveDesktopFileWatches(): DesktopFileWatches | null {
  if (!window.agentHost) {
    return null;
  }
  windowWatches ??= createDesktopFileWatches(windowHostConnection());
  return windowWatches;
}
