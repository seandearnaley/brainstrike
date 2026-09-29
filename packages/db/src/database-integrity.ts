import { createLogger } from '@brainstrike/logging';
import type { DatabaseIntegritySnapshot, DatabaseIntegrityState } from '@brainstrike/types';

const logger = createLogger('DatabaseIntegrityWatcher');

/**
 * Whether `background` database work may run in the given integrity state.
 *
 * The desktop main-process scheduler gate and the renderer-side hold both
 * decide through this one predicate, so a later `repairing` / `read-only`
 * state pauses background work everywhere by default instead of each surface
 * having to remember to add it. Only a healthy database admits background
 * writes.
 */
export function isBackgroundDatabaseWorkAdmitted(state: DatabaseIntegrityState): boolean {
  return state.kind === 'healthy';
}

/**
 * Renderer capability for reading the main-owned database integrity state.
 *
 * The desktop preload exposes it as `window.databaseIntegrity` (visible UI and
 * the embedding host only); its shape is derived from the desktop IPC contract
 * and pinned to this interface at compile time. Web has no such object.
 */
export interface DesktopDatabaseIntegrityBridge {
  /** The current snapshot; rejects when main cannot answer. */
  getState: () => Promise<DatabaseIntegritySnapshot>;
  /** Every state change main publishes; returns the unsubscribe. */
  onChanged: (callback: (snapshot: DatabaseIntegritySnapshot) => void) => () => void;
}

interface DesktopDatabaseIntegrityWindow {
  databaseIntegrity?: DesktopDatabaseIntegrityBridge;
}

/**
 * Read the optional desktop integrity capability without installing a global
 * type. `null` means the capability is absent (web, or a host that was not
 * given it): consumers decide by capability, never by platform check.
 */
export function getDesktopDatabaseIntegrityBridge(): DesktopDatabaseIntegrityBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return (window as DesktopDatabaseIntegrityWindow).databaseIntegrity ?? null;
}

export interface DatabaseIntegrityWatcher {
  /** The newest snapshot seen; resolves after the first read of main's state. */
  current(): Promise<DatabaseIntegritySnapshot>;
  /** Stops listening; rejects every pending wait and every later call. */
  dispose(): void;
  /** Called with each snapshot newer than the one held; returns the unsubscribe. */
  subscribe(listener: (snapshot: DatabaseIntegritySnapshot) => void): () => void;
  /**
   * Resolves once background database work is admitted. While it is not, every
   * call within the same episode returns the same promise.
   */
  waitUntilBackgroundAdmitted(): Promise<void>;
}

interface NonAdmittedEpisode {
  readonly promise: Promise<void>;
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
}

const DISPOSED_MESSAGE = 'Database integrity watcher was disposed.';

function createEpisode(): NonAdmittedEpisode {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

/**
 * Tracks main's integrity state for one renderer: it subscribes to the push
 * BEFORE the first read and keeps the highest revision, so a stale read that
 * resolves after a newer push never wins. A failed first read rejects that call
 * and is not cached; the next call reads again.
 */
export function createDatabaseIntegrityWatcher(
  bridge: DesktopDatabaseIntegrityBridge
): DatabaseIntegrityWatcher {
  const listeners = new Set<(snapshot: DatabaseIntegritySnapshot) => void>();
  let latest: DatabaseIntegritySnapshot | null = null;
  let firstRead: Promise<void> | null = null;
  let episode: NonAdmittedEpisode | null = null;
  let disposed = false;

  const accept = (snapshot: DatabaseIntegritySnapshot): void => {
    if (disposed || (latest !== null && snapshot.revision <= latest.revision)) {
      return;
    }
    latest = snapshot;
    if (episode !== null && isBackgroundDatabaseWorkAdmitted(snapshot.state)) {
      episode.resolve();
      episode = null;
    }
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        logger.error('Database integrity watcher subscriber failed', { error });
      }
    }
  };

  const unsubscribeFromBridge = bridge.onChanged(accept);

  const read = (): Promise<void> => {
    firstRead ??= bridge.getState().then(accept, (error: unknown) => {
      firstRead = null;
      throw error;
    });
    return firstRead;
  };

  const assertNotDisposed = (): void => {
    if (disposed) {
      throw new Error(DISPOSED_MESSAGE);
    }
  };

  const currentSnapshot = async (): Promise<DatabaseIntegritySnapshot> => {
    assertNotDisposed();
    await read();
    assertNotDisposed();
    if (latest === null) {
      throw new Error('Database integrity watcher has no snapshot after the first read.');
    }
    return latest;
  };

  const waitUntilBackgroundAdmitted = (): Promise<void> => {
    if (disposed) {
      return Promise.reject(new Error(DISPOSED_MESSAGE));
    }
    if (latest === null) {
      // Not `async`: once the state is known the contained branch below must
      // hand out the shared episode promise itself, not a wrapper around it.
      return read().then(waitUntilBackgroundAdmitted);
    }
    if (isBackgroundDatabaseWorkAdmitted(latest.state)) {
      return Promise.resolve();
    }
    episode ??= createEpisode();
    return episode.promise;
  };

  return {
    current: currentSnapshot,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeFromBridge();
      listeners.clear();
      episode?.reject(new Error(DISPOSED_MESSAGE));
      episode = null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    waitUntilBackgroundAdmitted,
  };
}
