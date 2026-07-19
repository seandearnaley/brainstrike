/**
 * File-system watch IPC domain (fs:watch / fs:unwatch / fs:watch-event).
 *
 * Watching runs in the MAIN process (chokidar via
 * `@brainstrike/file-system/electron`, injected by ipc-handlers.ts) and pushes
 * batched `FileSystemChange[]` payloads to the OWNING renderer only — the same
 * ownership/reaper model as the notes-vault watch channels. The renderer never
 * receives Node watcher objects; it holds an opaque `watchId` and a one-way
 * push subscription (see `ElectronRendererFileSystemAdapter.watchDirectory`).
 */
import { randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type {
  FileSystemChange,
  WatcherHealthEvent,
  WatcherHealthTransition,
} from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { ipcMain, type WebContents } from 'electron';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from '../platform/desktop-ipc-registry';
import { isMockFileSystemIpcPath, resolveFileSystemIpcPath } from './file-system-ipc';

const logger = createLogger('FileSystemWatchIpc');

export interface FileSystemWatchEventPayload {
  changes: FileSystemChange[];
  watchId: string;
}

export type StartFileSystemWatch = (
  directoryPath: string,
  onChanges: (changes: FileSystemChange[]) => void,
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
      reason: 'in-flight' | 'not-failed' | 'throttled' | 'unknown';
      retried: false;
      retryAfterMs?: number;
    };

export interface RegisterFileSystemWatchIpcHandlersOptions {
  /**
   * Start a recursive watcher for a validated directory path; returns a
   * disposer. Production wiring passes the chokidar-backed
   * `ElectronFileSystemAdapter.watchDirectory`; tests inject a fake.
   */
  readonly startWatch: StartFileSystemWatch;
}

/**
 * Upper bound on live watchers per renderer — a DoS guard, not a functional
 * limit (real usage is one watcher per mounted workspace root).
 */
export const MAX_FS_WATCHERS_PER_OWNER = 32;

interface LiveFileSystemWatcher {
  /** Consecutive failed transitions since the last healthy one. */
  consecutiveFailures: number;
  lastHealthState: WatcherHealthTransition['state'] | null;
  /** Earliest wall-clock time a manual retry may run. */
  nextRetryAllowedAt: number;
  readonly ownerId: number;
  /** The resolved directory path — retained for manual retry only. */
  readonly resolvedPath: string;
  retryInFlight: boolean;
  stop: () => void;
}

const liveWatchers = new Map<string, LiveFileSystemWatcher>();

/** In-memory telemetry counters (deliberately non-persistent). */
const telemetry = {
  cleanups: 0,
  failures: 0,
  healthPushes: 0,
  retries: 0,
};
// WeakSet — never strongly retain a WebContents (matches notes-vault).
const reaperAttachedOwners = new WeakSet<WebContents>();
// Slots reserved across a watch's async setup so concurrent requests observe
// the correct per-owner total BEFORE any entry lands in liveWatchers.
const reservedWatchersByOwner = new Map<number, number>();

function stopWatcher(watchId: string, entry: LiveFileSystemWatcher): void {
  telemetry.cleanups += 1;
  try {
    entry.stop();
  } catch (error) {
    logger.warn('Failed to stop file system watcher', { error, watchId });
  }
}

/**
 * Health sink for one watchId. Updates retry/backoff bookkeeping on the live
 * entry (if it still exists) and pushes the wire event to the OWNING renderer
 * only. Wire events carry no root path.
 */
function makeHealthSink(
  owner: WebContents,
  watchId: string
): (transition: WatcherHealthTransition) => void {
  return (transition) => {
    const entry = liveWatchers.get(watchId);
    if (entry) {
      entry.lastHealthState = transition.state;
      if (transition.state === 'failed') {
        entry.consecutiveFailures += 1;
        entry.retryInFlight = false;
        telemetry.failures += 1;
        const stepIndex = Math.min(
          entry.consecutiveFailures - 1,
          WATCH_RETRY_BACKOFF_MS.length - 1
        );
        entry.nextRetryAllowedAt = Date.now() + (WATCH_RETRY_BACKOFF_MS[stepIndex] ?? 0);
      } else if (transition.state === 'healthy') {
        entry.consecutiveFailures = 0;
        entry.nextRetryAllowedAt = 0;
        entry.retryInFlight = false;
      }
    }
    if (owner.isDestroyed()) {
      return;
    }
    const payload: WatcherHealthEvent = { ...transition, watchId };
    telemetry.healthPushes += 1;
    owner.send(DESKTOP_IPC_CHANNELS.files.watchHealth, payload);
  };
}

/** Change sink for one watchId — push to the OWNING renderer only. */
function makeChangeSink(
  owner: WebContents,
  watchId: string
): (changes: FileSystemChange[]) => void {
  return (changes) => {
    if (owner.isDestroyed()) {
      return;
    }
    const payload: FileSystemWatchEventPayload = { changes, watchId };
    owner.send(DESKTOP_IPC_CHANNELS.files.watchEvent, payload);
  };
}

function disposeFileSystemWatchersForWebContents(ownerId: number): void {
  for (const [watchId, entry] of liveWatchers) {
    if (entry.ownerId === ownerId) {
      liveWatchers.delete(watchId);
      stopWatcher(watchId, entry);
    }
  }
}

/** Stop and forget every live watcher (registrar disposer + tests). */
export function disposeAllFileSystemWatchers(): void {
  for (const [watchId, entry] of liveWatchers) {
    stopWatcher(watchId, entry);
  }
  liveWatchers.clear();
}

export function liveFileSystemWatcherCountForTest(): number {
  return liveWatchers.size;
}

function liveWatcherCountForOwner(ownerId: number): number {
  let count = 0;
  for (const entry of liveWatchers.values()) {
    if (entry.ownerId === ownerId) {
      count += 1;
    }
  }
  return count;
}

/** Live + in-flight (reserved) watchers for an owner. */
function committedWatcherCountForOwner(ownerId: number): number {
  return liveWatcherCountForOwner(ownerId) + (reservedWatchersByOwner.get(ownerId) ?? 0);
}

function reserveWatcherSlot(ownerId: number): void {
  reservedWatchersByOwner.set(ownerId, (reservedWatchersByOwner.get(ownerId) ?? 0) + 1);
}

function releaseWatcherSlot(ownerId: number): void {
  const next = (reservedWatchersByOwner.get(ownerId) ?? 0) - 1;
  if (next <= 0) {
    reservedWatchersByOwner.delete(ownerId);
  } else {
    reservedWatchersByOwner.set(ownerId, next);
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

export function registerFileSystemWatchIpcHandlers({
  startWatch,
}: RegisterFileSystemWatchIpcHandlersOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  // Telemetry counters are scoped to one registration (production registers
  // exactly once per app lifetime; tests re-register per case).
  telemetry.cleanups = 0;
  telemetry.failures = 0;
  telemetry.healthPushes = 0;
  telemetry.retries = 0;

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.watch,
    async (event, handle: DirectoryHandle): Promise<{ watchId: string }> => {
      const owner = event.sender;
      const requestedPath = handle?.path;
      if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
        throw new Error('fs:watch requires a directory handle with a non-empty path.');
      }
      if (owner.isDestroyed()) {
        throw new Error('fs:watch: the requesting renderer is already destroyed.');
      }
      // Count live AND in-flight (reserved) watchers: without the reservation,
      // N concurrent requests all pass this check before any inserts, blowing
      // past the cap. The reserved slot below closes that TOCTOU window.
      if (committedWatcherCountForOwner(owner.id) >= MAX_FS_WATCHERS_PER_OWNER) {
        throw new Error(
          `fs:watch: per-renderer watcher limit reached (${MAX_FS_WATCHERS_PER_OWNER}).`
        );
      }
      // Attach the teardown reaper BEFORE any await — a renderer destroyed
      // mid-setup must still be reaped.
      attachOwnerReaper(owner);

      const watchId = `fs-watch-${randomUUID()}`;

      // E2E mock roots have no on-disk directory: register an inert watcher so
      // unwatch/reaping stays uniform without pointing the engine at nothing.
      // No await before the insert, so no reservation is needed here.
      if (isMockFileSystemIpcPath(requestedPath)) {
        liveWatchers.set(watchId, {
          consecutiveFailures: 0,
          lastHealthState: null,
          nextRetryAllowedAt: 0,
          ownerId: owner.id,
          resolvedPath: requestedPath,
          retryInFlight: false,
          stop: () => {},
        });
        return { watchId };
      }

      // Hold a slot across the async setup so concurrent requests see it.
      reserveWatcherSlot(owner.id);
      try {
        const resolvedPath = await resolveFileSystemIpcPath(requestedPath, 'watch');
        const stats = await fsPromises.stat(resolvedPath);
        if (!stats.isDirectory()) {
          throw new Error(`Cannot watch "${resolvedPath}": not a directory.`);
        }

        const stop = startWatch(
          resolvedPath,
          makeChangeSink(owner, watchId),
          makeHealthSink(owner, watchId)
        );
        // The awaits above raced renderer teardown: if the owner is gone, its
        // reaper has already fired — stop immediately instead of leaking.
        if (owner.isDestroyed()) {
          stop();
          throw new Error('fs:watch: the requesting renderer was destroyed during setup.');
        }
        liveWatchers.set(watchId, {
          consecutiveFailures: 0,
          lastHealthState: null,
          nextRetryAllowedAt: 0,
          ownerId: owner.id,
          resolvedPath,
          retryInFlight: false,
          stop,
        });
        logger.debug('Started file system watcher', { path: resolvedPath, watchId });
        return { watchId };
      } finally {
        releaseWatcherSlot(owner.id);
      }
    }
  );

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.watchRetry,
    (event, rawWatchId: unknown): FileSystemWatchRetryResult => {
      const watchId = typeof rawWatchId === 'string' ? rawWatchId : '';
      const entry = liveWatchers.get(watchId);
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
      if (entry.lastHealthState !== 'failed') {
        return { reason: 'not-failed', retried: false };
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
      stopWatcher(watchId, entry);
      entry.stop = startWatch(
        entry.resolvedPath,
        makeChangeSink(owner, watchId),
        makeHealthSink(owner, watchId)
      );
      logger.info('Retrying file system watcher after deliberate request', {
        consecutiveFailures: entry.consecutiveFailures,
        watchId,
      });
      return { retried: true };
    }
  );

  registry.registerInvoke('files', DESKTOP_IPC_CHANNELS.files.watchTelemetry, () => ({
    activeWatchers: liveWatchers.size,
    ...telemetry,
  }));

  registry.registerInvoke(
    'files',
    DESKTOP_IPC_CHANNELS.files.unwatch,
    (event, rawWatchId: unknown): void => {
      const watchId = typeof rawWatchId === 'string' ? rawWatchId : '';
      const entry = liveWatchers.get(watchId);
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
      liveWatchers.delete(watchId);
      stopWatcher(watchId, entry);
    }
  );

  return () => {
    disposeAllFileSystemWatchers();
    registry.unregisterAll();
  };
}
