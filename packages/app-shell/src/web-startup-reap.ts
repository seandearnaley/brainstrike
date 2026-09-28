import { reapOrphanedAssistantThreadRuns } from '@brainstrike/assistant-data/assistant-thread-run-reaper';
import type { DbHandle } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

const logger = createLogger('WebStartupReap');

export interface WebStartupReapSnapshot {
  readonly error: Error | null;
  readonly status: 'idle' | 'pending' | 'ready' | 'error';
}

interface WebStartupReapStore {
  readonly listeners: Set<() => void>;
  promise: Promise<void> | null;
  snapshot: WebStartupReapSnapshot;
}

const IDLE_WEB_STARTUP_REAP: WebStartupReapSnapshot = {
  error: null,
  status: 'idle',
};
const webStartupReapStores = new WeakMap<DbHandle, WebStartupReapStore>();

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function getRendererBootedAt(): Date {
  const timeOrigin = globalThis.performance?.timeOrigin;
  if (typeof timeOrigin !== 'number' || !Number.isFinite(timeOrigin)) {
    throw new Error('Web assistant run cleanup requires a valid renderer time origin.');
  }
  return new Date(timeOrigin);
}

function getWebStartupReapStore(database: DbHandle): WebStartupReapStore {
  const existing = webStartupReapStores.get(database);
  if (existing) {
    return existing;
  }
  const store: WebStartupReapStore = {
    listeners: new Set(),
    promise: null,
    snapshot: IDLE_WEB_STARTUP_REAP,
  };
  webStartupReapStores.set(database, store);
  return store;
}

function publishWebStartupReap(store: WebStartupReapStore, snapshot: WebStartupReapSnapshot): void {
  store.snapshot = snapshot;
  for (const listener of store.listeners) {
    listener();
  }
}

function startWebStartupReap(database: DbHandle, store: WebStartupReapStore): void {
  if (store.promise) {
    return;
  }

  publishWebStartupReap(store, { error: null, status: 'pending' });
  store.promise = Promise.resolve()
    .then(async () => {
      // No missing-relation branch (BST-1651). This is behaviour-preserving
      // either way: the retired `runsTableMissing` check threw, and an
      // unmigrated database now rejects, and both publish the same `error`
      // snapshot. `schemaReady` (the repository has loaded for this resource,
      // so its schema probe passed) is a WEAKER guarantee than desktop's
      // `getDatabase()`-awaits-`migrate()`, so it is not load-bearing here —
      // the outcome does not depend on it. That is NOT licence to drop the
      // gate in `useActiveAssistantThreadIds`: its `canReadRuns` also gates its
      // live query, which must not subscribe before the repository has loaded
      // for this resource.
      const report = await reapOrphanedAssistantThreadRuns(database, getRendererBootedAt());
      if (report.reaped.length > 0) {
        logger.info('Web startup marked orphaned assistant runs failed', {
          runIds: report.reaped.map((run) => run.id),
        });
      }
    })
    .then(
      () => {
        publishWebStartupReap(store, { error: null, status: 'ready' });
      },
      (error: unknown) => {
        publishWebStartupReap(store, { error: toError(error), status: 'error' });
      }
    );
}

/**
 * Runs the web startup reap for `database` once and reports where it stands.
 * Rows a dead tab left `running` exist until it is `ready`, so `idle`,
 * `pending` and `error` must all read as UNKNOWN to a caller, never as "no runs".
 */
export function useWebStartupReap(
  database: DbHandle | null,
  enabled: boolean
): WebStartupReapSnapshot {
  const store = useMemo(() => (database ? getWebStartupReapStore(database) : null), [database]);
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      if (!store) {
        return () => undefined;
      }
      store.listeners.add(listener);
      if (enabled && database) {
        startWebStartupReap(database, store);
      }
      return () => {
        store.listeners.delete(listener);
      };
    },
    [database, enabled, store]
  );
  const getSnapshot = useCallback(
    (): WebStartupReapSnapshot => store?.snapshot ?? IDLE_WEB_STARTUP_REAP,
    [store]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
