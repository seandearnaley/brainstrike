import {
  createDatabaseIntegrityWatcher,
  type DesktopDatabaseIntegrityBridge,
  getDesktopDatabaseIntegrityBridge,
} from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';
import type { DatabaseIntegritySnapshot, DatabaseIntegrityState } from '@brainstrike/types';
import { useSyncExternalStore } from 'react';

const logger = createLogger('DatabaseIntegrity');

/**
 * What the renderer knows about the main-owned integrity state. `loading` is
 * the moment before the first read settles; `unreadable` is a failed read and
 * is never a claim of health.
 */
export type DatabaseIntegrityView =
  | { readonly status: 'loading' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'ready'; readonly snapshot: DatabaseIntegritySnapshot };

interface DatabaseIntegrityStore {
  getSnapshot: () => DatabaseIntegrityView | null;
  subscribe: (listener: () => void) => () => void;
}

/**
 * The states this renderer can show. Typed over the union, so a new state fails to compile until
 * it is listed; at runtime anything else (a newer main, a malformed payload) is shown as unreadable.
 */
const KNOWN_STATE_KINDS: Readonly<Record<DatabaseIntegrityState['kind'], true>> = {
  contained: true,
  healthy: true,
};

const LOADING: DatabaseIntegrityView = { status: 'loading' };
const UNREADABLE: DatabaseIntegrityView = { status: 'unreadable' };

/** The capability is absent (web): there is nothing to read and nothing to show. */
const ABSENT_STORE: DatabaseIntegrityStore = {
  getSnapshot: () => null,
  subscribe: () => () => undefined,
};

function createDatabaseIntegrityStore(
  bridge: DesktopDatabaseIntegrityBridge
): DatabaseIntegrityStore {
  const listeners = new Set<() => void>();
  let view: DatabaseIntegrityView = LOADING;
  let started = false;

  const publish = (next: DatabaseIntegrityView): void => {
    view = next;
    for (const listener of [...listeners]) {
      listener();
    }
  };

  // The watcher lives as long as the renderer and is never disposed: a
  // remounted notice must find the same one still listening. It keeps the
  // highest revision, so a stale first read never overwrites a newer push, and
  // it delivers the first read through `subscribe` because the listener is
  // registered before that read starts.
  const start = (): void => {
    started = true;
    const watcher = createDatabaseIntegrityWatcher(bridge);
    watcher.subscribe((snapshot) => {
      // Logged here, once per snapshot main sent, never during render.
      if (!Object.hasOwn(KNOWN_STATE_KINDS, snapshot.state.kind)) {
        logger.error('Unknown database integrity state; showing the status as unreadable', {
          kind: snapshot.state.kind,
          revision: snapshot.revision,
        });
      }
      publish({ snapshot, status: 'ready' });
    });
    watcher.current().catch((error: unknown) => {
      logger.error('Could not read the database integrity state', { error });
      // A push that already arrived is a known state; only an unknown one is unreadable.
      if (view.status !== 'ready') {
        publish(UNREADABLE);
      }
    });
  };

  return {
    getSnapshot: () => view,
    subscribe: (listener) => {
      listeners.add(listener);
      if (!started) {
        start();
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** One store, so one watcher, per bridge: per renderer, since the bridge is `window.databaseIntegrity`. */
const stores = new WeakMap<DesktopDatabaseIntegrityBridge, DatabaseIntegrityStore>();

function getDatabaseIntegrityStore(bridge: DesktopDatabaseIntegrityBridge): DatabaseIntegrityStore {
  const existing = stores.get(bridge);
  if (existing) {
    return existing;
  }
  const created = createDatabaseIntegrityStore(bridge);
  stores.set(bridge, created);
  return created;
}

/**
 * The renderer's view of the database integrity state, or `null` when the
 * desktop integrity capability is absent. Gated on the capability, never on the
 * platform.
 */
export function useDatabaseIntegrity(): DatabaseIntegrityView | null {
  const bridge = getDesktopDatabaseIntegrityBridge();
  const store = bridge === null ? ABSENT_STORE : getDatabaseIntegrityStore(bridge);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
