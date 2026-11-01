/**
 * ADR-0029 stage 4: the Explorer's recursive watches on live workspace roots,
 * owned by the agent host. A client asks for a root by its exact path; the
 * host checks it against the roots its own catalog records, runs one `fs.watch`
 * producer per canonical root for every client that watches it, and pushes each
 * batch and health transition only to the clients that hold a watch on it.
 *
 * - A client's watches end when its connection closes (`session.close`).
 * - Retry is manual only, and escalating minimum intervals bound it, so no
 *   loop can restart a watch on its own.
 * - A failed start is the visible rejection of `workspace/files/watch`.
 */
import { randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type {
  HostFileWatches,
  HostFileWatchSession,
  HostResults,
  WorkspaceFilesEvent,
} from '@brainstrike/agent-host';
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import { startJoinedRootWatch } from '@brainstrike/file-system/native-watch';
import type {
  FileSystemChange,
  FileSystemWatchBatchMetadata,
  WatcherHealthTransition,
} from '@brainstrike/types';
import type { WorkspaceRootResolver } from '../workspace-root-cwd.ts';

/** Minimum wait before each further manual retry of a watch that keeps failing. */
export const FILE_WATCH_RETRY_BACKOFF_MS = [1000, 5000, 30_000] as const;
/** A bound on one client's watches, not a functional limit (one per open root). */
export const MAX_FILE_WATCHES_PER_CLIENT = 64;

/** Starts one recursive watch; its disposer settles once the watch is closed. */
export type StartFileWatch = (
  rootPath: string,
  onChanges: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
  onHealth: (transition: WatcherHealthTransition) => void
) => Promise<() => Promise<void>>;

export interface HostFileWatchOptions {
  /**
   * Desktop E2E: a live root its synthetic test tree serves, with nothing on
   * disk behind it. Its watch is registered and reports nothing.
   */
  readonly isSyntheticRoot?: (rootPath: string) => boolean;
  readonly roots: WorkspaceRootResolver;
  /** Test seam; production watches with `startJoinedRootWatch`. */
  readonly startWatch?: StartFileWatch;
}

export interface HostFileWatchOwner {
  /** Stops every watch and refuses new ones. */
  close(): Promise<void>;
  readonly service: HostFileWatches;
}

type Send = (event: WorkspaceFilesEvent) => void;
type RetryResult = HostResults['workspace/files/watch-retry'];

interface Producer {
  consecutiveFailures: number;
  /** Bumped by each restart, so a replaced watch's late callbacks are dropped. */
  generation: number;
  health: WatcherHealthTransition | undefined;
  readonly listeners: Map<string, Send>;
  nextRetryAllowedAt: number;
  retrying: Promise<void> | undefined;
  readonly rootPath: string;
  started: Promise<() => Promise<void>>;
}

/**
 * The Explorer's own watch reports the bounded default-filter boundaries (BST-1180),
 * so Git views see `dist`/`build` activity the detailed records leave out.
 */
const watchExplorerRoot: StartFileWatch = (rootPath, onChanges, onHealth) =>
  startJoinedRootWatch(
    { kind: 'directory', name: path.basename(rootPath), path: rootPath, platform: 'electron' },
    onChanges,
    { onHealth, reportDefaultFilteredChanges: true }
  );

function unknownRoot(): Error {
  return refusalError(
    'authorization',
    'workspace.watch-root-unknown',
    'Only an open workspace folder can be watched.',
    'Open the folder in the workspace, then refresh.'
  );
}

function rootUnavailable(): Error {
  return refusalError(
    'availability',
    'workspace.watch-root-unavailable',
    'The workspace folder is not available to watch.',
    'Check that the folder still exists, then retry.'
  );
}

async function realpathOrUndefined(target: string): Promise<string | undefined> {
  try {
    return path.normalize(await fsPromises.realpath(target));
  } catch {
    return undefined;
  }
}

async function joinAll(work: readonly Promise<void>[], message: string): Promise<void> {
  const results = await Promise.allSettled(work);
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, message);
  }
}

/** Closes a started watch; a start that failed owns nothing to close. */
async function stopStarted(started: Promise<() => Promise<void>>): Promise<void> {
  let stop: (() => Promise<void>) | undefined;
  try {
    stop = await started;
  } catch {
    return;
  }
  await stop();
}

export function createHostFileWatches(options: HostFileWatchOptions): HostFileWatchOwner {
  const startWatch = options.startWatch ?? watchExplorerRoot;
  const producers = new Map<string, Producer>();
  const sessions = new Set<HostFileWatchSession>();
  let closed = false;

  const fanOut = (producer: Producer, event: (watchId: string) => WorkspaceFilesEvent): void => {
    for (const [watchId, send] of producer.listeners) {
      send(event(watchId));
    }
  };

  const recordHealth = (producer: Producer, transition: WatcherHealthTransition): void => {
    producer.health = transition;
    if (transition.state === 'failed') {
      producer.consecutiveFailures += 1;
      const step = Math.min(producer.consecutiveFailures, FILE_WATCH_RETRY_BACKOFF_MS.length) - 1;
      producer.nextRetryAllowedAt = Date.now() + (FILE_WATCH_RETRY_BACKOFF_MS[step] ?? 0);
    } else if (transition.state === 'healthy') {
      producer.consecutiveFailures = 0;
      producer.nextRetryAllowedAt = 0;
    }
    fanOut(producer, (watchId) => ({ ...transition, type: 'health', watchId }));
  };

  const start = (producer: Producer): Promise<() => Promise<void>> => {
    producer.generation += 1;
    const generation = producer.generation;
    const current = (): boolean => producer.generation === generation;
    return Promise.resolve().then(() =>
      startWatch(
        producer.rootPath,
        (changes, metadata) => {
          if (!current()) {
            return;
          }
          fanOut(producer, (watchId) => ({
            changes,
            ...(metadata
              ? {
                  filteredChangeBoundaries: [...metadata.filteredChangeBoundaries],
                  ...(metadata.filteredChangeBoundariesOverflow === true
                    ? { filteredChangeBoundariesOverflow: true as const }
                    : {}),
                }
              : {}),
            type: 'changes',
            watchId,
          }));
        },
        (transition) => {
          if (current()) {
            recordHealth(producer, transition);
          }
        }
      )
    );
  };

  const acquire = (rootPath: string, watchId: string, send: Send): Producer => {
    const existing = producers.get(rootPath);
    if (existing) {
      existing.listeners.set(watchId, send);
      return existing;
    }
    const producer: Producer = {
      consecutiveFailures: 0,
      generation: 0,
      health: undefined,
      listeners: new Map([[watchId, send]]),
      nextRetryAllowedAt: 0,
      retrying: undefined,
      rootPath,
      started: Promise.resolve(async () => undefined),
    };
    producer.started = start(producer);
    // A failed first start is no producer: the next watch starts afresh.
    producer.started.catch(() => {
      if (producers.get(rootPath) === producer && producer.retrying === undefined) {
        producers.delete(rootPath);
      }
    });
    producers.set(rootPath, producer);
    return producer;
  };

  const release = async (producer: Producer, watchId: string): Promise<void> => {
    producer.listeners.delete(watchId);
    if (producer.listeners.size > 0) {
      return;
    }
    if (producers.get(producer.rootPath) === producer) {
      producers.delete(producer.rootPath);
    }
    producer.generation += 1;
    await producer.retrying?.catch(() => undefined);
    await stopStarted(producer.started);
  };

  const retry = async (producer: Producer): Promise<RetryResult> => {
    if (producer.health?.state !== 'failed') {
      return { reason: 'not-failed', retried: false };
    }
    const failure = producer.health.failure;
    if (failure && (!failure.retryable || failure.terminal)) {
      return { reason: 'terminal', retried: false };
    }
    if (producer.retrying) {
      return { reason: 'in-flight', retried: false };
    }
    const now = Date.now();
    if (now < producer.nextRetryAllowedAt) {
      return {
        reason: 'throttled',
        retried: false,
        retryAfterMs: producer.nextRetryAllowedAt - now,
      };
    }
    const restart = (async (): Promise<void> => {
      const previous = producer.started;
      producer.generation += 1;
      await stopStarted(previous);
      producer.started = start(producer);
      await producer.started;
    })();
    producer.retrying = restart;
    try {
      await restart;
    } finally {
      producer.retrying = undefined;
    }
    return { retried: true };
  };

  /** The canonical path of the live root the client named, or `synthetic`. */
  const authorize = async (requestedPath: string): Promise<string | 'synthetic'> => {
    const requested = path.normalize(requestedPath);
    if (!path.isAbsolute(requested)) {
      throw unknownRoot();
    }
    const roots = await options.roots.listRoots();
    if (options.isSyntheticRoot?.(requested)) {
      if (roots.some((root) => path.normalize(root.path) === requested)) {
        return 'synthetic';
      }
      throw unknownRoot();
    }
    const canonical = await realpathOrUndefined(requested);
    for (const root of roots) {
      const rootPath = path.normalize(root.path);
      const rootCanonical = await realpathOrUndefined(rootPath);
      if (requested !== rootPath && requested !== rootCanonical) {
        continue;
      }
      if (!(canonical && canonical === rootCanonical)) {
        throw rootUnavailable();
      }
      const stats = await fsPromises.stat(canonical).catch(() => undefined);
      if (!stats?.isDirectory()) {
        throw rootUnavailable();
      }
      return canonical;
    }
    throw unknownRoot();
  };

  const open = (send: Send): HostFileWatchSession => {
    const held = new Map<string, Producer | 'synthetic'>();
    let sessionClosed = false;
    const assertOpen = (): void => {
      if (closed || sessionClosed) {
        throw refusalError(
          'availability',
          'workspace.files-closed',
          'File watching has stopped for this window.'
        );
      }
    };
    const session: HostFileWatchSession = {
      close: async () => {
        sessionClosed = true;
        sessions.delete(session);
        const releasing = [...held].flatMap(([watchId, producer]) =>
          producer === 'synthetic' ? [] : [release(producer, watchId)]
        );
        held.clear();
        await joinAll(releasing, "A closed client's file watches did not stop.");
      },
      'workspace/files/unwatch': async ({ watchId }) => {
        const producer = held.get(watchId);
        // An unknown id was already released (a removed root or a closed race).
        if (producer === undefined) {
          return null;
        }
        held.delete(watchId);
        if (producer !== 'synthetic') {
          await release(producer, watchId);
        }
        return null;
      },
      'workspace/files/watch': async ({ path: requestedPath }) => {
        assertOpen();
        if (held.size >= MAX_FILE_WATCHES_PER_CLIENT) {
          throw refusalError(
            'input',
            'workspace.files-watch-limit',
            `A window can hold at most ${MAX_FILE_WATCHES_PER_CLIENT} file watches.`
          );
        }
        const authorized = await authorize(requestedPath);
        assertOpen();
        const watchId = `fs-watch-${randomUUID()}`;
        if (authorized === 'synthetic') {
          held.set(watchId, 'synthetic');
          return { watchId };
        }
        const producer = acquire(authorized, watchId, send);
        held.set(watchId, producer);
        try {
          await producer.started;
        } catch (error) {
          if (held.get(watchId) === producer) {
            held.delete(watchId);
            await release(producer, watchId);
          }
          throw error;
        }
        if (held.get(watchId) !== producer) {
          throw refusalError(
            'availability',
            'workspace.files-closed',
            'File watching stopped while the watch was starting.'
          );
        }
        return { ...(producer.health ? { health: producer.health } : {}), watchId };
      },
      'workspace/files/watch-retry': async ({ watchId }) => {
        const producer = held.get(watchId);
        if (producer === undefined) {
          return { reason: 'unknown', retried: false };
        }
        if (producer === 'synthetic') {
          return { reason: 'not-failed', retried: false };
        }
        return await retry(producer);
      },
    };
    sessions.add(session);
    return session;
  };

  return {
    close: async () => {
      closed = true;
      await joinAll(
        [...sessions].map((session) => session.close()),
        'File watches did not stop.'
      );
    },
    service: { open },
  };
}
