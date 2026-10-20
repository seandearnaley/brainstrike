/**
 * Main's Notes Vault watcher owner: the ONE registry of live vault watchers,
 * keyed by watchId, plus the removed watchers whose native unsubscribe has
 * not yet succeeded.
 *
 * A watch is registered while its native subscription is still starting, so
 * the owner's renderer reaper or the terminal shutdown dispose joins that
 * acquisition and retires what it acquires. Renderer reapers (ONE per
 * WebContents via a WeakSet, mirroring terminal-ipc-handlers.ts) and unwatch
 * retire in the background; the shutdown dispose closes admission, joins
 * them all and retries, once, each one that failed. A @parcel/watcher
 * subscribe or unsubscribe still on the libuv pool when Electron frees Main's
 * Node environment completes into a dead JS context and aborts Main
 * (BST-2244).
 */
import { ParcelWatchRetirementError } from '@brainstrike/file-system/native-watch';
import { createLogger } from '@brainstrike/logging';
import type { WebContents } from 'electron';

const logger = createLogger('NotesVaultWatchers');

export const NOTES_VAULT_WATCHERS_SHUT_DOWN = 'Notes vault watchers are shut down.';
export const NOTES_VAULT_WATCH_OWNER_DESTROYED =
  'Notes vault watcher owner was destroyed during setup.';

/**
 * Starts one native watch. Resolves once the subscription is acquired, with a
 * disposer that settles once its unsubscribe has. A rejection owns no
 * subscription, except a `ParcelWatchRetirementError`, whose `retire` still
 * releases a late acquisition.
 */
export type StartNotesVaultNativeWatch = () => Promise<() => Promise<void>>;

export type NotesVaultWatchStart =
  | { readonly status: 'started' }
  | { readonly error: string; readonly status: 'refused' }
  | { readonly error: unknown; readonly status: 'failed' };

interface LiveNotesVaultWatcher {
  readonly ownerId: number;
  /**
   * Joins the native acquisition, then retires it; settles once its
   * unsubscribe has. A call while one is in flight joins it; a call after one
   * rejected retries it, matching the joined producer's retryable disposer.
   */
  readonly stop: () => Promise<void>;
}

const liveWatchers = new Map<string, LiveNotesVaultWatcher>();
/** Removed watchers, kept until their native unsubscribe succeeds. */
const retiringWatchers = new Map<string, LiveNotesVaultWatcher>();
const reaperAttachedOwners = new WeakSet<WebContents>();
let admissionOpen = true;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createLiveWatcher(
  ownerId: number,
  starting: Promise<() => Promise<void>>
): LiveNotesVaultWatcher {
  let retirement: Promise<void> | undefined;
  return {
    ownerId,
    stop: () => {
      if (retirement) {
        return retirement;
      }
      retirement = starting.then(
        (stop) => stop(),
        // The watch caller reports the startup failure; only a late acquisition is owned.
        (error: unknown) =>
          error instanceof ParcelWatchRetirementError ? error.retire() : undefined
      );
      retirement.catch(() => {
        retirement = undefined;
      });
      return retirement;
    },
  };
}

/**
 * Starts (or joins, or retries) a removed watcher's retirement. The watcher
 * stays owned in `retiringWatchers` until its unsubscribe succeeds, so the
 * shutdown dispose joins it or retries it.
 */
function stopWatcher(watchId: string, entry: LiveNotesVaultWatcher): Promise<void> {
  retiringWatchers.set(watchId, entry);
  const retirement = entry.stop();
  retirement.then(
    () => {
      retiringWatchers.delete(watchId);
    },
    (error: unknown) => {
      // Logged, never swallowed silently (no-silent-fallbacks); the watcher
      // stays owned, and the shutdown dispose retries it.
      logger.warn('Failed to stop notes vault watcher', {
        error: toErrorMessage(error),
        watchId,
      });
    }
  );
  return retirement;
}

/** Reaps every watcher `owner` owns when it is destroyed (window closed or navigated away). */
function attachOwnerReaper(owner: WebContents): void {
  if (reaperAttachedOwners.has(owner)) {
    return;
  }
  reaperAttachedOwners.add(owner);
  owner.once('destroyed', () => {
    reaperAttachedOwners.delete(owner);
    disposeNotesVaultWatchersForWebContents(owner.id);
  });
}

/**
 * Admits, registers and starts one watch for `owner`. Refused once the
 * terminal dispose has begun or the owner is gone; there is no await before
 * the registration, so neither can race it.
 */
export async function startNotesVaultWatch(
  owner: WebContents,
  watchId: string,
  start: StartNotesVaultNativeWatch
): Promise<NotesVaultWatchStart> {
  if (!admissionOpen) {
    return { error: NOTES_VAULT_WATCHERS_SHUT_DOWN, status: 'refused' };
  }
  if (owner.isDestroyed()) {
    return { error: NOTES_VAULT_WATCH_OWNER_DESTROYED, status: 'refused' };
  }
  const starting = start();
  const entry = createLiveWatcher(owner.id, starting);
  liveWatchers.set(watchId, entry);
  attachOwnerReaper(owner);
  try {
    await starting;
  } catch (error) {
    if (liveWatchers.get(watchId) === entry) {
      liveWatchers.delete(watchId);
      // Releases a ParcelWatchRetirementError's late acquisition, if any.
      void stopWatcher(watchId, entry);
    }
    return { error, status: 'failed' };
  }
  if (liveWatchers.get(watchId) !== entry) {
    // Reaped or shut down during setup; that remover retires it.
    return {
      error: owner.isDestroyed()
        ? NOTES_VAULT_WATCH_OWNER_DESTROYED
        : NOTES_VAULT_WATCHERS_SHUT_DOWN,
      status: 'refused',
    };
  }
  return { status: 'started' };
}

/**
 * Stops `watchId` for its owner. False for an unknown id AND for a non-owner,
 * so a caller can answer both identically (no ownership-leak oracle).
 */
export function unwatchNotesVaultWatcher(watchId: string, requesterId: number): boolean {
  const entry = liveWatchers.get(watchId);
  if (!entry) {
    return false;
  }
  if (entry.ownerId !== requesterId) {
    logger.warn('Rejected notes vault unwatch from non-owner renderer', {
      ownerId: entry.ownerId,
      requesterId,
      watchId,
    });
    return false;
  }
  liveWatchers.delete(watchId);
  void stopWatcher(watchId, entry);
  return true;
}

/** Stop + drop every watcher owned by a destroyed/navigated-away renderer. */
export function disposeNotesVaultWatchersForWebContents(ownerId: number): number {
  let reaped = 0;
  for (const [watchId, entry] of Array.from(liveWatchers.entries())) {
    if (entry.ownerId !== ownerId) {
      continue;
    }
    liveWatchers.delete(watchId);
    void stopWatcher(watchId, entry);
    reaped += 1;
  }
  if (reaped > 0) {
    logger.info('Reaped notes vault watchers for destroyed renderer', { count: reaped, ownerId });
  }
  return reaped;
}

/**
 * The terminal shutdown dispose: closes watch admission, stops every live
 * watcher (including ones still starting), and resolves only once every
 * native subscribe and unsubscribe this owner started has settled, unwatch and
 * renderer reaper retirements included. Each call retries, once, every
 * retirement whose unsubscribe failed earlier. A failed unsubscribe rejects,
 * as an `AggregateError`, after the others settle, and its watcher stays
 * owned for the next call.
 */
export async function disposeAllNotesVaultWatchers(): Promise<void> {
  admissionOpen = false;
  const entries = Array.from(liveWatchers.entries());
  liveWatchers.clear();
  const retirements = [...retiringWatchers, ...entries].map(([watchId, entry]) =>
    stopWatcher(watchId, entry)
  );
  if (entries.length > 0) {
    logger.info('Reaped live notes vault watchers on dispose', { count: entries.length });
  }
  const results = await Promise.allSettled(retirements);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Notes vault watcher retirement failed.');
  }
}

/** A fresh IPC registration (or a test reset) admits watches again. */
export function reopenNotesVaultWatchAdmission(): void {
  admissionOpen = true;
}

/** Test-only: current count of live watchers, including ones still starting. */
export function liveNotesVaultWatcherCountForTest(): number {
  return liveWatchers.size;
}
