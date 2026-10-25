/**
 * The Explorer's folder watchers, one session per desktop client connection.
 *
 * Each client holds opaque watch ids; batches and health changes go only to the
 * client that started them. Several registrations of one folder in one client
 * share that client's single borrow of the folder's native watcher. A closed
 * connection stops every watcher it started, as a closed window's did.
 */
import { randomUUID } from 'node:crypto';
import type { HostWorkspaceWatchSession, WorkspaceFilesEvent } from '@brainstrike/agent-host';
import { ParcelWatchRetirementError } from '@brainstrike/file-system/native-watch';
import { createLogger } from '@brainstrike/logging';
import type {
  FileSystemChange,
  FileSystemWatchBatchMetadata,
  WatcherHealthTransition,
} from '@brainstrike/types';
import type { VisibleRootWatch } from './desktop-workspace-roots';

const logger = createLogger('DesktopWorkspaceWatches');

/**
 * Retry is manual only (BST-568): no loop retries a failed watcher, and this
 * escalating minimum interval bounds a client that asks too often.
 */
export const WATCH_RETRY_BACKOFF_MS = [1000, 5000, 30_000] as const;
/** A guard, not a functional limit: real use is one watcher per mounted folder. */
export const MAX_WATCHERS_PER_CLIENT = 32;
/** Two surfaces may share every mounted folder; duplicates beyond that are refused. */
export const MAX_WATCH_REGISTRATIONS_PER_CLIENT = MAX_WATCHERS_PER_CLIENT * 2;

type RetryResult =
  | { readonly retried: true }
  | {
      readonly reason: 'in-flight' | 'not-failed' | 'terminal' | 'throttled' | 'unknown';
      readonly retried: false;
      readonly retryAfterMs?: number;
    };

interface Watcher {
  acquisition: Promise<void>;
  /** Consecutive failed transitions since the last healthy one. */
  consecutiveFailures: number;
  /** The latest transition, returned with a registration that missed the push. */
  health: WatcherHealthTransition | undefined;
  nextRetryAllowedAt: number;
  readonly path: string;
  retired: boolean;
  retirement: Promise<void> | undefined;
  retiring: boolean;
  retry: () => Promise<void>;
  retryInFlight: boolean;
  setupStartedAt: number | undefined;
  stop: () => Promise<void>;
  readonly watchIds: Set<string>;
}

interface WatchSessionsOptions {
  /** True for an E2E mock folder: its watcher is inert. */
  readonly isSynthetic: (directoryPath: string) => Promise<boolean>;
  /** The client's path, validated, as an existing directory. */
  readonly resolveDirectory: (directoryPath: string) => Promise<string>;
  readonly startWatch: (
    directoryPath: string,
    onChanges: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
    onHealth: (transition: WatcherHealthTransition) => void
  ) => Promise<VisibleRootWatch>;
}

export interface WorkspaceWatchSessions {
  open(send: (event: WorkspaceFilesEvent) => void): HostWorkspaceWatchSession;
  telemetry(): {
    readonly activeWatchers: number;
    readonly batches: number;
    readonly cleanups: number;
    readonly degradedTransitions: number;
    readonly duplicateRegistrations: number;
    readonly events: number;
    readonly failures: number;
    readonly healthPushes: number;
    readonly lastSetupLatencyMs: number;
    readonly retries: number;
    readonly setupLatencySamples: number;
  };
}

interface WatchCounters {
  batches: number;
  cleanups: number;
  /** A lower bound: the engine dedupes repeated same-state errors. */
  degradedTransitions: number;
  duplicateRegistrations: number;
  events: number;
  failures: number;
  healthPushes: number;
  lastSetupLatencyMs: number;
  retries: number;
  setupLatencySamples: number;
}

/** A watcher's retry and backoff bookkeeping, and the counters, for one health transition. */
function recordHealth(
  watcher: Watcher,
  transition: WatcherHealthTransition,
  counters: WatchCounters
): void {
  if (transition.state === 'starting') {
    watcher.setupStartedAt = Date.now();
  } else if (transition.state === 'healthy' && watcher.setupStartedAt !== undefined) {
    counters.lastSetupLatencyMs = Date.now() - watcher.setupStartedAt;
    counters.setupLatencySamples += 1;
    watcher.setupStartedAt = undefined;
  } else if (transition.state === 'degraded') {
    counters.degradedTransitions += 1;
  }
  watcher.health = transition;
  if (transition.state === 'failed') {
    watcher.consecutiveFailures += 1;
    watcher.retryInFlight = false;
    counters.failures += 1;
    const step = Math.min(watcher.consecutiveFailures - 1, WATCH_RETRY_BACKOFF_MS.length - 1);
    watcher.nextRetryAllowedAt = Date.now() + (WATCH_RETRY_BACKOFF_MS[step] ?? 0);
  } else if (transition.state === 'healthy') {
    watcher.consecutiveFailures = 0;
    watcher.nextRetryAllowedAt = 0;
    watcher.retryInFlight = false;
  }
}

async function joinAll(retiring: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(retiring);
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, 'File system watch retirement failed.');
  }
}

export function createWorkspaceWatchSessions({
  isSynthetic,
  resolveDirectory,
  startWatch,
}: WatchSessionsOptions): WorkspaceWatchSessions {
  /** In-memory counters (BST-568), never persisted. */
  const counters: WatchCounters = {
    batches: 0,
    cleanups: 0,
    degradedTransitions: 0,
    duplicateRegistrations: 0,
    events: 0,
    failures: 0,
    healthPushes: 0,
    lastSetupLatencyMs: 0,
    retries: 0,
    setupLatencySamples: 0,
  };
  const live = new Set<Map<string, Watcher>>();

  const stopWatcher = (watcher: Watcher): Promise<void> => {
    if (watcher.retired) {
      return Promise.resolve();
    }
    watcher.retiring = true;
    watcher.retirement ??= (async () => {
      counters.cleanups += 1;
      await watcher.stop();
      watcher.retired = true;
    })().finally(() => {
      watcher.retirement = undefined;
    });
    return watcher.retirement;
  };

  const open = (send: (event: WorkspaceFilesEvent) => void): HostWorkspaceWatchSession => {
    const byPath = new Map<string, Watcher>();
    const byId = new Map<string, Watcher>();
    const retiring = new Set<Watcher>();
    let closed = false;
    live.add(byPath);

    const forget = (watcher: Watcher): Promise<void> => {
      byPath.delete(watcher.path);
      for (const watchId of watcher.watchIds) {
        byId.delete(watchId);
      }
      watcher.watchIds.clear();
      retiring.add(watcher);
      return stopWatcher(watcher).finally(() => retiring.delete(watcher));
    };
    const assertCapacity = (): void => {
      let registrations = 0;
      for (const watcher of byPath.values()) {
        registrations += watcher.watchIds.size;
      }
      if (registrations >= MAX_WATCH_REGISTRATIONS_PER_CLIENT) {
        throw new Error(
          `files/watch: per-client watcher registration limit reached (${MAX_WATCH_REGISTRATIONS_PER_CLIENT}).`
        );
      }
    };
    const assertNewWatcher = (): void => {
      if (byPath.size >= MAX_WATCHERS_PER_CLIENT) {
        throw new Error(
          `files/watch: per-client watcher limit reached (${MAX_WATCHERS_PER_CLIENT}).`
        );
      }
    };
    const registration = (
      watchId: string,
      watcher: Watcher
    ): { health?: WatcherHealthTransition; watchId: string } => ({
      ...(watcher.health ? { health: watcher.health } : {}),
      watchId,
    });
    const share = (watcher: Watcher, watchId: string): void => {
      watcher.watchIds.add(watchId);
      byId.set(watchId, watcher);
      counters.duplicateRegistrations += 1;
      logger.warn('Shared native watcher for duplicate file system registration', {
        path: watcher.path,
        watchId,
      });
    };
    const newWatcher = (directoryPath: string, watchId: string): Watcher => {
      const watcher: Watcher = {
        acquisition: Promise.resolve(),
        consecutiveFailures: 0,
        health: undefined,
        nextRetryAllowedAt: 0,
        path: directoryPath,
        retired: false,
        retirement: undefined,
        retiring: false,
        retry: async () => {
          throw new Error('Synthetic root watch has no native producer to retry.');
        },
        retryInFlight: false,
        setupStartedAt: undefined,
        stop: async () => undefined,
        watchIds: new Set([watchId]),
      };
      byPath.set(directoryPath, watcher);
      byId.set(watchId, watcher);
      return watcher;
    };
    const onHealth =
      (watcher: Watcher) =>
      (transition: WatcherHealthTransition): void => {
        recordHealth(watcher, transition, counters);
        if (closed || watcher.retiring) {
          return;
        }
        for (const watchId of watcher.watchIds) {
          counters.healthPushes += 1;
          send({ health: transition, type: 'health', watchId });
        }
      };
    const onChanges =
      (watcher: Watcher) =>
      (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata): void => {
        if (closed || watcher.retiring) {
          return;
        }
        counters.batches += 1;
        counters.events += changes.length;
        for (const watchId of watcher.watchIds) {
          send({
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
          });
        }
      };
    const registerSynthetic = (
      directoryPath: string,
      watchId: string
    ): { health?: WatcherHealthTransition; watchId: string } => {
      assertCapacity();
      const existing = byPath.get(directoryPath);
      if (existing) {
        share(existing, watchId);
        return registration(watchId, existing);
      }
      assertNewWatcher();
      return registration(watchId, newWatcher(directoryPath, watchId));
    };
    /** A start that failed forgets its registrations, and retires what it acquired. */
    const abandonStart = async (
      watcher: Watcher,
      error: unknown,
      acquired: boolean
    ): Promise<void> => {
      byPath.delete(watcher.path);
      for (const id of watcher.watchIds) {
        byId.delete(id);
      }
      watcher.watchIds.clear();
      if (acquired || watcher.retiring || error instanceof ParcelWatchRetirementError) {
        try {
          await stopWatcher(watcher);
        } catch (retirementError) {
          throw new ParcelWatchRetirementError([error, retirementError], () =>
            stopWatcher(watcher)
          );
        }
      }
    };
    const startNative = async (directoryPath: string, watchId: string) => {
      // Registered before the engine starts: it can report health during setup.
      const watcher = newWatcher(directoryPath, watchId);
      watcher.retry = async () => {
        throw new Error('Root watch acquisition has not completed.');
      };
      let acquired = false;
      const starting = Promise.resolve().then(() =>
        startWatch(directoryPath, onChanges(watcher), onHealth(watcher))
      );
      watcher.acquisition = starting.then(() => {
        acquired = true;
      });
      // Duplicate registrations await this same promise; the primary setup reports its error.
      watcher.acquisition.catch(() => undefined);
      watcher.stop = async () => {
        let subscription: VisibleRootWatch;
        try {
          subscription = await starting;
        } catch (error) {
          if (error instanceof ParcelWatchRetirementError) {
            await error.retire();
          }
          return;
        }
        await subscription.close();
      };
      try {
        const subscription = await starting;
        watcher.stop = () => subscription.close();
        watcher.retry = () => subscription.retry();
      } catch (error) {
        await abandonStart(watcher, error, acquired);
        throw error;
      }
      // The client closed during setup: stop the watcher it can no longer reach.
      if (closed || watcher.retiring || !byId.has(watchId)) {
        await forget(watcher);
        throw new Error('files/watch: the requesting client closed during setup.');
      }
      return registration(watchId, watcher);
    };

    return {
      close: async () => {
        closed = true;
        live.delete(byPath);
        await joinAll([...[...byPath.values()].map(forget), ...[...retiring].map(stopWatcher)]);
      },
      'files/unwatch': async ({ watchId }) => {
        const watcher = byId.get(watchId);
        if (!watcher) {
          // Races with a closing client are normal.
          logger.debug('files/unwatch for an unknown watch id', { watchId });
          return {};
        }
        if (watcher.watchIds.size === 1) {
          // Keep the last registration until native retirement succeeds, so a failed
          // unwatch stays retryable instead of reporting success while still watching.
          await stopWatcher(watcher);
          byPath.delete(watcher.path);
        }
        byId.delete(watchId);
        watcher.watchIds.delete(watchId);
        return {};
      },
      'files/watch': async ({ handle }) => {
        if (closed) {
          throw new Error('files/watch: the requesting client has closed.');
        }
        if (handle.path.length === 0) {
          throw new Error('files/watch requires a directory handle with a non-empty path.');
        }
        const watchId = `fs-watch-${randomUUID()}`;
        // An E2E mock folder has nothing on disk: its watcher is inert, so unwatch and
        // close stay uniform without pointing the engine at nothing.
        if (await isSynthetic(handle.path)) {
          return registerSynthetic(handle.path, watchId);
        }
        const directoryPath = await resolveDirectory(handle.path);
        if (closed) {
          throw new Error('files/watch: the requesting client closed during setup.');
        }
        // No await between the lookup, the caps and the insert: concurrent requests serialize.
        assertCapacity();
        if ([...retiring].some((watcher) => watcher.path === directoryPath)) {
          throw new Error('files/watch: previous native watch retirement has not completed.');
        }
        const existing = byPath.get(directoryPath);
        if (existing) {
          share(existing, watchId);
          await existing.acquisition;
          return registration(watchId, existing);
        }
        assertNewWatcher();
        return startNative(directoryPath, watchId);
      },
      'files/watch-retry': async ({ watchId }): Promise<RetryResult> => {
        const watcher = byId.get(watchId);
        if (!watcher || watcher.retiring) {
          return { reason: 'unknown', retried: false };
        }
        if (watcher.health?.state !== 'failed') {
          return { reason: 'not-failed', retried: false };
        }
        const failure = watcher.health.failure;
        if (failure && (!failure.retryable || failure.terminal)) {
          return { reason: 'terminal', retried: false };
        }
        if (watcher.retryInFlight) {
          return { reason: 'in-flight', retried: false };
        }
        const now = Date.now();
        if (now < watcher.nextRetryAllowedAt) {
          return {
            reason: 'throttled',
            retried: false,
            retryAfterMs: watcher.nextRetryAllowedAt - now,
          };
        }
        watcher.retryInFlight = true;
        counters.retries += 1;
        // The shared producer is joined and replaced; the index keeps its borrow.
        try {
          await watcher.retry();
        } finally {
          watcher.retryInFlight = false;
        }
        logger.info('Retrying file system watcher after deliberate request', {
          consecutiveFailures: watcher.consecutiveFailures,
          watchId,
        });
        return { retried: true };
      },
    };
  };

  return {
    open,
    telemetry: () => {
      let activeWatchers = 0;
      for (const session of live) {
        activeWatchers += session.size;
      }
      return { activeWatchers, ...counters };
    },
  };
}
