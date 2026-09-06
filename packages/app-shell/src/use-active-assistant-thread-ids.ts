import { hasDurableAssistantUsageCapability } from '@brainstrike/assistant-data';
import { reapOrphanedAssistantThreadRuns } from '@brainstrike/assistant-data/assistant-thread-run-reaper';
import { type DbHandle, makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

const ACTIVE_ASSISTANT_THREAD_IDS_SQL = `
  SELECT thread_id AS "threadId"
  FROM brainstrike_assistant_thread_runs
  WHERE resource_id = $1
    AND status = 'running'
  GROUP BY thread_id
  ORDER BY thread_id ASC
`;

const EMPTY_ACTIVE_THREAD_IDS: ReadonlySet<string> = new Set<string>();
const logger = createLogger('ActiveAssistantThreadIds');

interface ActiveAssistantThreadIdRow {
  readonly threadId: unknown;
}

export interface ActiveAssistantThreadIdsState {
  readonly error: Error | null;
  readonly loading: boolean;
  readonly threadIds: ReadonlySet<string>;
}

interface WebStartupReapSnapshot {
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
      // the outcome does not depend on it.
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

function useWebStartupReap(database: DbHandle | null, enabled: boolean): WebStartupReapSnapshot {
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

function projectActiveThreadIds(rows: readonly ActiveAssistantThreadIdRow[]): {
  readonly error: Error | null;
  readonly threadIds: ReadonlySet<string>;
} {
  const threadIds = new Set<string>();
  for (const row of rows) {
    if (typeof row.threadId !== 'string' || !row.threadId.trim()) {
      return {
        error: new Error('Active assistant thread query returned an invalid thread id.'),
        threadIds: new Set(),
      };
    }
    threadIds.add(row.threadId);
  }
  return { error: null, threadIds };
}

/**
 * One durable, resource-scoped activity projection for the whole Threads panel.
 *
 * Run creation and every terminal lifecycle path already write the shared
 * PGlite `thread_runs` table. Subscribing to that table keeps concurrent,
 * background, reattached, deleted, and startup-reaped runs on the same source
 * of truth without per-row subscriptions, timers, or a parallel activity store.
 */
export function useActiveAssistantThreadIds({
  database,
  resourceId,
  schemaReady,
}: {
  readonly database: DbHandle | null;
  readonly resourceId: string;
  readonly schemaReady: boolean;
}): ActiveAssistantThreadIdsState {
  const canReadRuns = database !== null && schemaReady;
  const desktopOwnsRunLifecycle = hasDurableAssistantUsageCapability();
  const webStartupReap = useWebStartupReap(database, canReadRuns && !desktopOwnsRunLifecycle);
  const startupReady = desktopOwnsRunLifecycle || webStartupReap.status === 'ready';
  const liveQuery = usePGliteLiveQuery<ActiveAssistantThreadIdRow>({
    cacheKey: makeLiveQueryKey('active-assistant-thread-ids', resourceId),
    clearOnDisable: true,
    enabled: canReadRuns && startupReady,
    params: [resourceId],
    query: ACTIVE_ASSISTANT_THREAD_IDS_SQL,
  });
  const projection = useMemo(() => projectActiveThreadIds(liveQuery.rows), [liveQuery.rows]);
  const startupError = webStartupReap.status === 'error' ? webStartupReap.error : null;
  const error = startupError ?? liveQuery.error ?? projection.error;

  return {
    error,
    loading: liveQuery.loading || (!desktopOwnsRunLifecycle && webStartupReap.status === 'pending'),
    threadIds: error ? EMPTY_ACTIVE_THREAD_IDS : projection.threadIds,
  };
}
