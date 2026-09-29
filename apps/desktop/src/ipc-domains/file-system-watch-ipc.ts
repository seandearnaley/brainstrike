/**
 * File-system watch IPC domain (fs:watch / fs:unwatch / fs:watch-event).
 *
 * Watching runs in the MAIN process (@parcel/watcher via
 * `@brainstrike/file-system/electron`, injected by ipc-handlers.ts) and pushes
 * batched `FileSystemChange[]` payloads plus optional bounded filtered-boundary
 * evidence to the OWNING renderer only — the same ownership / reaper model as
 * the notes-vault watch channels. The renderer never receives Node watcher
 * objects; it holds an opaque `watchId` and a one-way push subscription (see
 * `ElectronRendererFileSystemAdapter.watchDirectory`).
 */
import { randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { createLogger } from '@brainstrike/logging';
import type {
  FileSystemChange,
  FileSystemWatchBatchMetadata,
  WatcherHealthEvent,
  WatcherHealthTransition,
} from '@brainstrike/types';
import { ipcMain, type WebContents } from 'electron';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import { fileSystemWatchContract } from './file-system.contract';
import { isMockFileSystemIpcPath, resolveFileSystemIpcPath } from './file-system-ipc';

const logger = createLogger('FileSystemWatchIpc');

export interface FileSystemWatchEventPayload {
  changes: FileSystemChange[];
  filteredChangeBoundaries?: readonly string[];
  filteredChangeBoundariesOverflow?: true;
  watchId: string;
}

export type StartFileSystemWatch = (
  directoryPath: string,
  onChanges: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
  onHealth: (transition: WatcherHealthTransition) => void
) => () => void;

/**
 * Retry throttling (BST-568 slice 3, settled ruling): retry is MANUAL-ONLY —
 * there is no auto-retry loop in main, so a retry storm has no engine to run
 * on. The escalating minimum interval below bounds even a hostile renderer
 * hammering fs:watch-retry, and the single-flight guard keeps at most one
 * active subscription-or-retry per watchId.
 */
export const WATCH_RETRY_BACKOFF_MS = [1000, 5000, 30_000] as const;

export type FileSystemWatchRetryResult =
  | { retried: true }
  | {
      reason: 'in-flight' | 'not-failed' | 'terminal' | 'throttled' | 'unknown';
      retried: false;
      retryAfterMs?: number;
    };

export interface RegisterFileSystemWatchIpcHandlersOptions {
  /**
   * Start a recursive watcher for a validated directory path; returns a
   * disposer. Production wiring passes the parcel-backed
   * `ElectronFileSystemAdapter.watchDirectory`; tests inject a fake.
   */
  readonly startWatch: StartFileSystemWatch;
}

/**
 * Upper bound on live watchers per renderer — a DoS guard, not a functional
 * limit (real usage is one watcher per mounted workspace root).
 */
export const MAX_FS_WATCHERS_PER_OWNER = 32;
/**
 * Bound logical fan-out separately from native subscriptions. Two renderer
 * surfaces may legitimately share every mounted root, but repeated duplicate
 * registrations must not grow MAIN-process state or event fan-out without limit.
 */
export const MAX_FS_WATCH_REGISTRATIONS_PER_OWNER = MAX_FS_WATCHERS_PER_OWNER * 2;

interface LiveFileSystemWatcher {
  /** Consecutive failed transitions since the last healthy one. */
  consecutiveFailures: number;
  /**
   * The latest transition recorded for this watch. Returned with the fs:watch
   * response so a renderer that was not yet listening (setup-time failures push
   * before the response resolves) still learns the current state; the retry
   * path reads `.state` off it. Deliberately ONE field — a parallel
   * `lastHealthState` would have to be hand-kept in sync with this, and two
   * fields that can drift apart are a bug waiting to happen.
   */
  lastHealthTransition: WatcherHealthTransition | null;
  /** Earliest wall-clock time a manual retry may run. */
  nextRetryAllowedAt: number;
  readonly ownerId: number;
  /** The resolved directory path — retained for manual retry only. */
  readonly resolvedPath: string;
  retryInFlight: boolean;
  /** Timestamp for the current native setup-latency sample. */
  setupStartedAt: number | undefined;
  stop: () => void;
  /** Stable owner/path identity for the single native subscription. */
  readonly subscriptionKey: string;
  /** Logical renderer registrations sharing this native subscription. */
  readonly watchIds: Set<string>;
}

const liveWatchersBySubscription = new Map<string, LiveFileSystemWatcher>();
const liveWatchersById = new Map<string, LiveFileSystemWatcher>();

/** In-memory telemetry counters (deliberately non-persistent, BST-568). */
const telemetry = {
  /** Change batches pushed to renderers. */
  batches: 0,
  cleanups: 0,
  /**
   * healthy→degraded transitions. The engine emits each WITH a root
   * invalidation, but dedupes repeated same-state errors — so this is a
   * LOWER BOUND on invalidation batches, not a per-batch count (which is
   * only renderer-observable via the refresh events themselves).
   */
  degradedTransitions: 0,
  /** Same-owner, same-root logical registrations sharing an existing native watcher. */
  duplicateRegistrations: 0,
  /** Individual FileSystemChange entries across all batches. */
  events: 0,
  failures: 0,
  healthPushes: 0,
  /** Milliseconds from 'starting' to 'healthy' for the latest setup. */
  lastSetupLatencyMs: 0,
  retries: 0,
  /** Number of starting→healthy latency samples observed. */
  setupLatencySamples: 0,
};

// WeakSet — never strongly retain a WebContents (matches notes-vault).
const reaperAttachedOwners = new WeakSet<WebContents>();
// Invalidates async watch setup that belongs to a renderer context reaped
// during path resolution. WeakMap preserves the no-strong-retention contract.
const ownerLifecycleGenerations = new WeakMap<WebContents, number>();

function ownerLifecycleGeneration(owner: WebContents): number {
  return ownerLifecycleGenerations.get(owner) ?? 0;
}

function stopWatcher(entry: LiveFileSystemWatcher): void {
  telemetry.cleanups += 1;
  try {
    entry.stop();
  } catch (error) {
    logger.warn('Failed to stop file system watcher', {
      error,
      path: entry.resolvedPath,
    });
  }
}

function subscriptionKey(ownerId: number, resolvedPath: string): string {
  return `${ownerId}\0${resolvedPath}`;
}

function forgetWatcher(entry: LiveFileSystemWatcher): void {
  liveWatchersBySubscription.delete(entry.subscriptionKey);
  for (const watchId of entry.watchIds) {
    liveWatchersById.delete(watchId);
  }
  entry.watchIds.clear();
  stopWatcher(entry);
}

/**
 * Health sink for one native subscription. Updates shared retry/backoff
 * bookkeeping and fans the wire event out to every logical watchId owned by
 * this renderer. Wire events carry no root-path FIELD — the renderer resolves
 * watchId back to its own root. (failure.message may quote the owner's own path
 * for diagnostics; owner scoping means it never crosses renderer boundaries.)
 */
function makeHealthSink(
  owner: WebContents,
  entry: LiveFileSystemWatcher
): (transition: WatcherHealthTransition) => void {
  return (transition) => {
    if (transition.state === 'starting') {
      entry.setupStartedAt = Date.now();
    } else if (transition.state === 'healthy') {
      const startedAt = entry.setupStartedAt;
      if (startedAt !== undefined) {
        entry.setupStartedAt = undefined;
        telemetry.lastSetupLatencyMs = Date.now() - startedAt;
        telemetry.setupLatencySamples += 1;
      }
    } else if (transition.state === 'degraded') {
      telemetry.degradedTransitions += 1;
    }
    entry.lastHealthTransition = transition;
    if (transition.state === 'failed') {
      entry.consecutiveFailures += 1;
      entry.retryInFlight = false;
      telemetry.failures += 1;
      const stepIndex = Math.min(entry.consecutiveFailures - 1, WATCH_RETRY_BACKOFF_MS.length - 1);
      entry.nextRetryAllowedAt = Date.now() + (WATCH_RETRY_BACKOFF_MS[stepIndex] ?? 0);
    } else if (transition.state === 'healthy') {
      entry.consecutiveFailures = 0;
      entry.nextRetryAllowedAt = 0;
      entry.retryInFlight = false;
    }
    if (owner.isDestroyed()) {
      return;
    }
    for (const watchId of entry.watchIds) {
      const payload: WatcherHealthEvent = { ...transition, watchId };
      telemetry.healthPushes += 1;
      owner.send(DESKTOP_IPC_CHANNELS.files.watchHealth, payload);
    }
  };
}

/** Change sink for one native subscription — fan out within its owner only. */
function makeChangeSink(
  owner: WebContents,
  entry: LiveFileSystemWatcher
): (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void {
  return (changes, metadata) => {
    if (owner.isDestroyed()) {
      return;
    }
    telemetry.batches += 1;
    telemetry.events += changes.length;
    for (const watchId of entry.watchIds) {
      const payload: FileSystemWatchEventPayload = {
        changes,
        ...(metadata
          ? {
              filteredChangeBoundaries: [...metadata.filteredChangeBoundaries],
              ...(metadata.filteredChangeBoundariesOverflow === true
                ? { filteredChangeBoundariesOverflow: true as const }
                : {}),
            }
          : {}),
        watchId,
      };
      owner.send(DESKTOP_IPC_CHANNELS.files.watchEvent, payload);
    }
  };
}

function disposeFileSystemWatchersForWebContents(ownerId: number): void {
  for (const entry of liveWatchersBySubscription.values()) {
    if (entry.ownerId === ownerId) {
      forgetWatcher(entry);
    }
  }
}

function registerSharedWatchId(entry: LiveFileSystemWatcher, watchId: string): void {
  entry.watchIds.add(watchId);
  liveWatchersById.set(watchId, entry);
  telemetry.duplicateRegistrations += 1;
  logger.warn('Shared native watcher for duplicate file system registration', {
    ownerId: entry.ownerId,
    path: entry.resolvedPath,
    watchId,
  });
}

/** Stop and forget every live watcher (registrar disposer + tests). */
export function disposeAllFileSystemWatchers(): void {
  for (const entry of liveWatchersBySubscription.values()) {
    forgetWatcher(entry);
  }
}

export function liveFileSystemWatcherCountForTest(): number {
  return liveWatchersBySubscription.size;
}

function liveWatcherCountForOwner(ownerId: number): number {
  let count = 0;
  for (const entry of liveWatchersBySubscription.values()) {
    if (entry.ownerId === ownerId) {
      count += 1;
    }
  }
  return count;
}

function assertWatchRegistrationCapacity(ownerId: number): void {
  let count = 0;
  for (const entry of liveWatchersBySubscription.values()) {
    if (entry.ownerId !== ownerId) {
      continue;
    }
    count += entry.watchIds.size;
    if (count >= MAX_FS_WATCH_REGISTRATIONS_PER_OWNER) {
      throw new Error(
        `fs:watch: per-renderer watcher registration limit reached (${MAX_FS_WATCH_REGISTRATIONS_PER_OWNER}).`
      );
    }
  }
}

/**
 * Reap every watcher this renderer owns when its context goes away. Attached
 * BEFORE any async setup work so a mid-setup teardown can never miss it.
 * Covers all three teardown shapes: window closed ('destroyed'), renderer
 * crash ('render-process-gone' — the WebContents survives), and main-frame
 * reload/navigation ('did-navigate' — the old context's disposers are gone).
 *
 * Because 'did-navigate' fires while the WebContents SURVIVES, `reap` must
 * remove ALL teardown listeners when any one fires — otherwise the siblings
 * of the fired event linger and the next fs:watch re-attaches a fresh set,
 * piling listeners up on one WebContents (MaxListenersExceededWarning + a
 * closure leak). Listeners are re-attached on the next fs:watch after a reap.
 */
function attachOwnerReaper(owner: WebContents): void {
  if (reaperAttachedOwners.has(owner)) {
    return;
  }
  reaperAttachedOwners.add(owner);
  const reap = (): void => {
    ownerLifecycleGenerations.set(owner, ownerLifecycleGeneration(owner) + 1);
    reaperAttachedOwners.delete(owner);
    // Remove ALL teardown listeners — a fired 'did-navigate' leaves the
    // WebContents alive, so its siblings would otherwise linger and pile up.
    owner.removeListener('destroyed', reap);
    owner.removeListener('render-process-gone', reap);
    owner.removeListener('did-navigate', reap);
    disposeFileSystemWatchersForWebContents(owner.id);
  };
  owner.on('destroyed', reap);
  owner.on('render-process-gone', reap);
  owner.on('did-navigate', reap);
}

interface FileSystemWatchRegistration {
  health?: WatcherHealthTransition;
  watchId: string;
}

function watchRegistration(
  watchId: string,
  entry?: LiveFileSystemWatcher
): FileSystemWatchRegistration {
  return {
    ...(entry?.lastHealthTransition ? { health: entry.lastHealthTransition } : {}),
    watchId,
  };
}

function registerMockFileSystemWatcher(
  owner: WebContents,
  requestedPath: string,
  watchId: string
): FileSystemWatchRegistration {
  assertWatchRegistrationCapacity(owner.id);
  const key = subscriptionKey(owner.id, requestedPath);
  const existing = liveWatchersBySubscription.get(key);
  if (existing) {
    registerSharedWatchId(existing, watchId);
    return watchRegistration(watchId, existing);
  }
  if (liveWatcherCountForOwner(owner.id) >= MAX_FS_WATCHERS_PER_OWNER) {
    throw new Error(`fs:watch: per-renderer watcher limit reached (${MAX_FS_WATCHERS_PER_OWNER}).`);
  }
  const entry: LiveFileSystemWatcher = {
    consecutiveFailures: 0,
    lastHealthTransition: null,
    nextRetryAllowedAt: 0,
    ownerId: owner.id,
    resolvedPath: requestedPath,
    retryInFlight: false,
    setupStartedAt: undefined,
    stop: () => {},
    subscriptionKey: key,
    watchIds: new Set([watchId]),
  };
  liveWatchersBySubscription.set(key, entry);
  liveWatchersById.set(watchId, entry);
  return { watchId };
}

function startNewFileSystemWatcher(
  owner: WebContents,
  resolvedPath: string,
  watchId: string,
  startWatch: StartFileSystemWatch
): FileSystemWatchRegistration {
  // Register BEFORE starting the engine. Engines can emit health synchronously
  // during setup, and retry bookkeeping must observe those transitions.
  const key = subscriptionKey(owner.id, resolvedPath);
  const entry: LiveFileSystemWatcher = {
    consecutiveFailures: 0,
    lastHealthTransition: null,
    nextRetryAllowedAt: 0,
    ownerId: owner.id,
    resolvedPath,
    retryInFlight: false,
    setupStartedAt: undefined,
    stop: () => {},
    subscriptionKey: key,
    watchIds: new Set([watchId]),
  };
  liveWatchersBySubscription.set(key, entry);
  liveWatchersById.set(watchId, entry);

  try {
    entry.stop = startWatch(
      resolvedPath,
      makeChangeSink(owner, entry),
      makeHealthSink(owner, entry)
    );
  } catch (error) {
    liveWatchersBySubscription.delete(key);
    liveWatchersById.delete(watchId);
    throw error;
  }

  // Path resolution raced renderer teardown: its reaper already ran, so stop
  // this just-created watcher immediately instead of leaking it.
  if (owner.isDestroyed()) {
    forgetWatcher(entry);
    throw new Error('fs:watch: the requesting renderer was destroyed during setup.');
  }
  logger.debug('Started file system watcher', { path: resolvedPath, watchId });
  return watchRegistration(watchId, entry);
}

export function registerFileSystemWatchIpcHandlers({
  startWatch,
}: RegisterFileSystemWatchIpcHandlersOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  // Telemetry counters are scoped to one registration (production registers
  // exactly once per app lifetime; tests re-register per case).
  telemetry.batches = 0;
  telemetry.cleanups = 0;
  telemetry.events = 0;
  telemetry.failures = 0;
  telemetry.healthPushes = 0;
  telemetry.lastSetupLatencyMs = 0;
  telemetry.retries = 0;
  telemetry.degradedTransitions = 0;
  telemetry.duplicateRegistrations = 0;
  telemetry.setupLatencySamples = 0;

  registry.registerAuthorizedInvoke(
    'files',
    fileSystemWatchContract.watchDirectory.channel,
    { roles: fileSystemWatchContract.watchDirectory.roles },
    async (event, ...raw): Promise<FileSystemWatchRegistration> => {
      const [handle] = fileSystemWatchContract.watchDirectory.parseArgs(raw);
      const owner = event.sender;
      const requestedPath = handle?.path;
      if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
        throw new Error('fs:watch requires a directory handle with a non-empty path.');
      }
      if (owner.isDestroyed()) {
        throw new Error('fs:watch: the requesting renderer is already destroyed.');
      }
      // Attach the teardown reaper BEFORE any await — a renderer destroyed
      // mid-setup must still be reaped.
      const lifecycleGeneration = ownerLifecycleGeneration(owner);
      attachOwnerReaper(owner);

      const watchId = `fs-watch-${randomUUID()}`;

      // E2E mock roots have no on-disk directory: register an inert watcher so
      // unwatch/reaping stays uniform without pointing the engine at nothing.
      // No await before the insert, so no reservation is needed here.
      if (isMockFileSystemIpcPath(requestedPath)) {
        return registerMockFileSystemWatcher(owner, requestedPath, watchId);
      }

      const resolvedPath = await resolveFileSystemIpcPath(requestedPath, 'watch');
      const stats = await fsPromises.stat(resolvedPath);
      if (!stats.isDirectory()) {
        throw new Error(`Cannot watch "${resolvedPath}": not a directory.`);
      }
      if (ownerLifecycleGeneration(owner) !== lifecycleGeneration) {
        throw new Error('fs:watch: renderer context changed during setup.');
      }

      // The lookup, cap check, and insert below contain no await, so concurrent
      // invokes serialize here without a reservation TOCTOU. Logical fan-out is
      // bounded independently; an in-budget duplicate may still share the
      // existing native subscription when the native cap is full.
      assertWatchRegistrationCapacity(owner.id);
      const key = subscriptionKey(owner.id, resolvedPath);
      const existing = liveWatchersBySubscription.get(key);
      if (existing) {
        registerSharedWatchId(existing, watchId);
        return watchRegistration(watchId, existing);
      }
      if (liveWatcherCountForOwner(owner.id) >= MAX_FS_WATCHERS_PER_OWNER) {
        throw new Error(
          `fs:watch: per-renderer watcher limit reached (${MAX_FS_WATCHERS_PER_OWNER}).`
        );
      }
      return startNewFileSystemWatcher(owner, resolvedPath, watchId, startWatch);
    }
  );

  registry.registerAuthorizedInvoke(
    'files',
    fileSystemWatchContract.retryWatch.channel,
    { roles: fileSystemWatchContract.retryWatch.roles },
    (event, ...raw): FileSystemWatchRetryResult => {
      const [watchId] = fileSystemWatchContract.retryWatch.parseArgs(raw);
      const entry = liveWatchersById.get(watchId);
      // Unknown and non-owner produce IDENTICAL results — no ownership oracle.
      if (!entry || entry.ownerId !== event.sender.id) {
        if (entry) {
          logger.warn('Rejected fs:watch-retry from non-owner renderer', {
            ownerId: entry.ownerId,
            requesterId: event.sender.id,
            watchId,
          });
        }
        return { reason: 'unknown', retried: false };
      }
      if (entry.lastHealthTransition?.state !== 'failed') {
        return { reason: 'not-failed', retried: false };
      }
      const failure = entry.lastHealthTransition.failure;
      if (failure && (!failure.retryable || failure.terminal)) {
        return { reason: 'terminal', retried: false };
      }
      if (entry.retryInFlight) {
        return { reason: 'in-flight', retried: false };
      }
      const now = Date.now();
      if (now < entry.nextRetryAllowedAt) {
        return {
          reason: 'throttled',
          retried: false,
          retryAfterMs: entry.nextRetryAllowedAt - now,
        };
      }

      entry.retryInFlight = true;
      telemetry.retries += 1;
      const owner = event.sender;
      // Release whatever the failed engine still holds before re-subscribing —
      // at most one active subscription-or-retry per root.
      stopWatcher(entry);
      entry.stop = startWatch(
        entry.resolvedPath,
        makeChangeSink(owner, entry),
        makeHealthSink(owner, entry)
      );
      logger.info('Retrying file system watcher after deliberate request', {
        consecutiveFailures: entry.consecutiveFailures,
        watchId,
      });
      return { retried: true };
    }
  );

  registry.registerAuthorizedInvoke(
    'files',
    fileSystemWatchContract.getWatcherTelemetry.channel,
    { roles: fileSystemWatchContract.getWatcherTelemetry.roles },
    (_event, ...raw) => {
      fileSystemWatchContract.getWatcherTelemetry.parseArgs(raw);
      return {
        activeWatchers: liveWatchersBySubscription.size,
        ...telemetry,
      };
    }
  );

  registry.registerAuthorizedInvoke(
    'files',
    fileSystemWatchContract.unwatchDirectory.channel,
    { roles: fileSystemWatchContract.unwatchDirectory.roles },
    (event, ...raw): void => {
      const [watchId] = fileSystemWatchContract.unwatchDirectory.parseArgs(raw);
      const entry = liveWatchersById.get(watchId);
      if (!entry) {
        // Disposal races with the destroyed-owner reaper are normal; log only.
        logger.debug('fs:unwatch for unknown watchId — already reaped?', { watchId });
        return;
      }
      if (entry.ownerId !== event.sender.id) {
        // Same outcome as an unknown id — no ownership-leak oracle.
        logger.warn('Rejected fs:unwatch from non-owner renderer', {
          ownerId: entry.ownerId,
          requesterId: event.sender.id,
          watchId,
        });
        return;
      }
      liveWatchersById.delete(watchId);
      entry.watchIds.delete(watchId);
      if (entry.watchIds.size === 0) {
        liveWatchersBySubscription.delete(entry.subscriptionKey);
        stopWatcher(entry);
      }
    }
  );

  return () => {
    disposeAllFileSystemWatchers();
    registry.unregisterAll();
  };
}
