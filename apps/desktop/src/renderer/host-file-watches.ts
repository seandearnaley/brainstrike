import type { HostClient } from '@brainstrike/agent-host/browser';
import type { HostParams, WorkspaceFilesEvent } from '@brainstrike/agent-host/protocol';
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
import type { DesktopHostConnection } from './desktop-host-connection';

const logger = createLogger('DesktopFileWatches');

type WatchChanges = (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void;

/** The Explorer's folder watchers, as the file system adapter exposes them. */
export interface DesktopFileWatches {
  onWatcherHealth(callback: (event: WatcherRootHealthEvent) => void): () => void;
  retryWatcher(rootPath: string): Promise<WatcherRetryOutcome>;
  watchDirectory(
    handle: DirectoryHandle,
    onChanges: WatchChanges,
    onSignal?: (signal: FileSystemWatchSignal) => void
  ): () => void;
}

/** The host a watch runs on; `hostWatchId` arrives with the host's answer. */
interface Binding {
  readonly host: HostClient;
  hostWatchId?: string;
}

/** One watch the app holds. Its id is this window's, and outlives any one host. */
interface Watch {
  binding: Binding | undefined;
  readonly handle: DirectoryHandle;
  /** The last transition, whose backend a lost host's failure names. */
  health: WatcherHealthTransition | undefined;
  readonly id: string;
  readonly onChanges: WatchChanges;
  readonly onSignal: ((signal: FileSystemWatchSignal) => void) | undefined;
  /** A later start follows a gap whose changes nobody saw. */
  started: boolean;
}

/** What one host connection knows of this window's watches. */
interface HostWatches {
  readonly byHostId: Map<string, Watch>;
  /** Health a host pushed before its answer to the watch's start. */
  readonly early: Map<string, WatcherHealthTransition>;
  starting: number;
}

/** The wire handle: exactly the fields the host's schema reads. */
export function wireDirectoryHandle(handle: DirectoryHandle): HostParams<'files/watch'>['handle'] {
  return {
    kind: 'directory',
    name: handle.name,
    path: handle.path,
    platform: handle.platform,
    ...(handle.rootId === undefined ? {} : { rootId: handle.rootId }),
  };
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** The newer of the health pushed before the start's answer and the answer's own. */
function latestOf(
  early: WatcherHealthTransition | undefined,
  answered: WatcherHealthTransition | undefined
): WatcherHealthTransition | undefined {
  return early && (!answered || early.timestamp >= answered.timestamp) ? early : answered;
}

function deliverChanges(
  watch: Watch,
  event: Extract<WorkspaceFilesEvent, { type: 'changes' }>
): void {
  const changes = [...event.changes];
  if (event.filteredChangeBoundaries && event.filteredChangeBoundaries.length > 0) {
    watch.onChanges(changes, {
      filteredChangeBoundaries: event.filteredChangeBoundaries,
      ...(event.filteredChangeBoundariesOverflow === true
        ? { filteredChangeBoundariesOverflow: true }
        : {}),
    });
  } else if (changes.length > 0) {
    watch.onChanges(changes);
  }
}

/** A host refused the start: the folder is visibly unwatched until a new host runs it. */
function reportStartFailure(watch: Watch, cause: unknown): void {
  const message = messageOf(cause);
  logger.warn('A folder watcher could not start; the folder is unwatched', {
    error: message,
    path: watch.handle.path,
  });
  watch.onSignal?.({
    message: `File watching could not start for ${watch.handle.path}: ${message}`,
    type: 'errored',
  });
}

/**
 * ADR-0029 stage 4: the agent host runs the Explorer's watchers, and they belong
 * to the connection that started them. Each watch the app holds keeps a stable
 * id here. When the frame's host connection is lost, its watches report
 * `failed`; when a client connects again, every open watch starts on it and
 * asks its consumers for a full refresh of the gap. There is no timer and no
 * retry loop: a new connection is the only trigger.
 */
export function createDesktopFileWatches(connection: DesktopHostConnection): DesktopFileWatches {
  const watches = new Map<string, Watch>();
  const hosts = new Map<HostClient, HostWatches>();
  const latestByRootPath = new Map<string, WatcherRootHealthEvent>();
  const subscribers = new Set<(event: WatcherRootHealthEvent) => void>();
  let nextId = 0;

  const dispatchHealth = (watch: Watch, transition: WatcherHealthTransition): void => {
    watch.health = transition;
    const event: WatcherRootHealthEvent = {
      ...transition,
      rootPath: watch.handle.path,
      watchId: watch.id,
    };
    latestByRootPath.set(event.rootPath, event);
    for (const subscriber of [...subscribers]) {
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

  /** A watch with no host: its health says so where a backend is known, its signal always. */
  const reportUnwatched = (watch: Watch, message: string): void => {
    if (watch.health) {
      dispatchHealth(watch, {
        backend: watch.health.backend,
        failure: { code: 'host-disconnected', message, retryable: false, terminal: false },
        state: 'failed',
        timestamp: Date.now(),
      });
      return;
    }
    watch.onSignal?.({ message, type: 'errored' });
  };

  const receive = (host: HostClient, state: HostWatches, event: WorkspaceFilesEvent): void => {
    const owner = state.byHostId.get(event.watchId);
    // A watch that moved to another host hears only that host.
    const watch = owner?.binding?.host === host ? owner : undefined;
    if (event.type === 'health') {
      if (watch) {
        dispatchHealth(watch, event.health);
      } else if (!owner && state.starting > 0) {
        state.early.set(event.watchId, event.health);
      }
      return;
    }
    if (watch) {
      deliverChanges(watch, event);
    }
  };

  const lost = (host: HostClient) => (): void => {
    hosts.delete(host);
    for (const watch of watches.values()) {
      if (watch.binding?.host === host) {
        watch.binding = undefined;
        reportUnwatched(
          watch,
          'The agent host connection was lost; file watching resumes when it reconnects.'
        );
      }
    }
  };

  const attach = (host: HostClient): HostWatches => {
    const existing = hosts.get(host);
    if (existing) {
      return existing;
    }
    const state: HostWatches = { byHostId: new Map(), early: new Map(), starting: 0 };
    hosts.set(host, state);
    host.onWorkspaceFiles((event) => receive(host, state, event));
    host.closed.then(lost(host), lost(host));
    return state;
  };

  const stop = (host: HostClient, hostWatchId: string): void => {
    host.request('files/unwatch', { watchId: hostWatchId }).catch((cause: unknown) => {
      logger.warn('Could not stop a folder watcher', { error: messageOf(cause), hostWatchId });
    });
  };

  /** A host now runs the watch; a later start asks its consumers to refresh the gap. */
  const run = (watch: Watch, initial: WatcherHealthTransition | undefined): void => {
    if (watch.started) {
      watch.onSignal?.({ type: 'overflow' });
    }
    watch.started = true;
    if (initial) {
      dispatchHealth(watch, initial);
    }
  };

  const start = async (watch: Watch, host: HostClient): Promise<void> => {
    if (!watches.has(watch.id) || watch.binding?.host === host) {
      return;
    }
    const state = attach(host);
    const binding: Binding = { host };
    watch.binding = binding;
    state.starting += 1;
    try {
      const started = await host.request('files/watch', {
        handle: wireDirectoryHandle(watch.handle),
      });
      const early = state.early.get(started.watchId);
      state.early.delete(started.watchId);
      if (watch.binding === binding) {
        binding.hostWatchId = started.watchId;
        state.byHostId.set(started.watchId, watch);
        run(watch, latestOf(early, started.health));
      } else if (!watches.has(watch.id)) {
        stop(host, started.watchId);
      }
    } catch (cause) {
      if (watch.binding === binding) {
        watch.binding = undefined;
        reportStartFailure(watch, cause);
      }
    } finally {
      state.starting -= 1;
      if (state.starting === 0) {
        state.early.clear();
      }
    }
  };

  // A client that connects after a loss, the user's Reconnect included, runs every open watch.
  connection.subscribe(() => {
    const snapshot = connection.getSnapshot();
    if (snapshot.kind !== 'connected') {
      return;
    }
    for (const watch of watches.values()) {
      void start(watch, snapshot.client);
    }
  });

  return {
    onWatcherHealth: (callback) => {
      for (const event of latestByRootPath.values()) {
        callback(event);
      }
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    retryWatcher: async (rootPath) => {
      const watch = [...watches.values()].find((candidate) => candidate.handle.path === rootPath);
      const binding = watch?.binding;
      if (!binding) {
        return { reason: 'unknown', retried: false };
      }
      if (binding.hostWatchId === undefined) {
        return { reason: 'in-flight', retried: false };
      }
      return await binding.host.request('files/watch-retry', { watchId: binding.hostWatchId });
    },
    watchDirectory: (handle, onChanges, onSignal) => {
      nextId += 1;
      const watch: Watch = {
        binding: undefined,
        handle,
        health: undefined,
        id: `watch-${nextId}`,
        onChanges,
        onSignal,
        started: false,
      };
      watches.set(watch.id, watch);
      connection.current().then(
        (host) => start(watch, host),
        (cause: unknown) => {
          if (watches.has(watch.id) && !watch.binding) {
            reportUnwatched(
              watch,
              `File watching could not start for ${handle.path}: ${messageOf(cause)}`
            );
          }
        }
      );
      return () => {
        if (!watches.delete(watch.id)) {
          return;
        }
        const binding = watch.binding;
        watch.binding = undefined;
        if (latestByRootPath.get(handle.path)?.watchId === watch.id) {
          latestByRootPath.delete(handle.path);
        }
        if (binding?.hostWatchId !== undefined) {
          hosts.get(binding.host)?.byHostId.delete(binding.hostWatchId);
          stop(binding.host, binding.hostWatchId);
        }
      };
    },
  };
}
