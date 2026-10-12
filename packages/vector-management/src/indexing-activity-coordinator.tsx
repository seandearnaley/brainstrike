import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import {
  type IndexingBackfillSnapshot,
  type IndexingDatabaseWorkSnapshot,
  type IndexingManagedCollectionStatsState,
  type IndexingQueueSnapshot,
  type IndexingWorkerSnapshot,
  useIndexingActivityStore,
} from '@brainstrike/app-state/stores/indexing-activity-store';
import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import {
  createPriorityDbHandle,
  getCollectionIndexingStats,
  getDatabaseWorkScheduler,
  getDesktopDatabaseBridge,
} from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { isAppActive, useAppActive } from '@brainstrike/hooks';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { useEffect, useMemo, useRef } from 'react';
import { useSharedEmbeddingRuntime } from './embedding-runtime-provider';
import type {
  EmbeddingRuntimeBackfillInfo,
  EmbeddingRuntimeBackfillProgress,
  EmbeddingRuntimeStatus,
} from './vector-status/embedding-runtime-controller';
import { EMBEDDINGS_QUEUE } from './vector-status/vector-queue-service';

const QUEUE_AGGREGATE_QUERY = `
  SELECT
    COUNT(*) FILTER (WHERE state = 'queued')::int AS "queued",
    COUNT(*) FILTER (WHERE state = 'running')::int AS "running",
    COUNT(*) FILTER (WHERE state = 'failed')::int AS "failed",
    COUNT(*) FILTER (WHERE state = 'succeeded')::int AS "succeeded",
    COALESCE(
      (SELECT succeeded_total FROM job_queue_metrics WHERE queue = $1),
      0
    )::bigint AS "succeededLifetime",
    MIN(run_at) FILTER (WHERE state = 'queued') AS "nextRunnableAt"
  FROM job_queue
  WHERE queue = $1
`.trim();
const DATABASE_WORK_SNAPSHOT_POLL_MS = 500;
const MANAGED_COLLECTION_STATS_POLL_MS = 1000;
const QUEUE_SNAPSHOT_POLL_MS = 1000;

interface QueueAggregateRow {
  readonly failed: number | string | null;
  readonly nextRunnableAt: string | null;
  readonly queued: number | string | null;
  readonly running: number | string | null;
  readonly succeeded: number | string | null;
  readonly succeededLifetime: number | string | null;
}

function toNonNegativeInteger(value: number | string | null, fieldName: string): number {
  const numericValue = typeof value === 'number' ? value : Number(value ?? 0);
  if (!(Number.isInteger(numericValue) && numericValue >= 0)) {
    throw new Error(`Invalid indexing queue ${fieldName} count: ${String(value)}`);
  }
  return numericValue;
}

function toQueueSnapshot(row: QueueAggregateRow): IndexingQueueSnapshot {
  return {
    failed: toNonNegativeInteger(row.failed, 'failed'),
    nextRunnableAt: row.nextRunnableAt ?? null,
    queued: toNonNegativeInteger(row.queued, 'queued'),
    running: toNonNegativeInteger(row.running, 'running'),
    succeeded: toNonNegativeInteger(row.succeeded, 'succeeded'),
    succeededLifetime: toNonNegativeInteger(row.succeededLifetime, 'succeededLifetime'),
  };
}

function toWorkerSnapshot(status: EmbeddingRuntimeStatus): IndexingWorkerSnapshot {
  return {
    lastError: status.lastError,
    state: status.state,
  };
}

function toBackfillSnapshot(backfill: EmbeddingRuntimeBackfillInfo): IndexingBackfillSnapshot {
  return {
    current: backfill.progress?.current ?? null,
    embeddingSetId: backfill.embeddingSetId,
    requestId: backfill.requestId,
    source: backfill.source,
    total: backfill.progress?.total ?? null,
  };
}

function toProgressBackfillSnapshot(
  progress: EmbeddingRuntimeBackfillProgress
): IndexingBackfillSnapshot {
  return {
    current: progress.current,
    embeddingSetId: progress.embeddingSetId,
    requestId: progress.requestId,
    source: progress.source,
    total: progress.total,
  };
}

function isQueueActive(queue: IndexingQueueSnapshot): boolean {
  return queue.queued > 0 || queue.running > 0;
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type CollectionStatsDatabase = Parameters<typeof getCollectionIndexingStats>[0];

async function readManagedCollectionStats(
  db: CollectionStatsDatabase,
  collectionId: string
): Promise<IndexingManagedCollectionStatsState> {
  const stats = await getCollectionIndexingStats(db, collectionId, {
    label: 'managed collection stats',
    priority: 'background',
  });
  if (stats && stats.embeddingSetId !== collectionId) {
    throw new Error(
      `Managed collection stats identity mismatch: expected ${collectionId}, received ${stats.embeddingSetId}`
    );
  }
  return {
    collectionId,
    error: null,
    stats,
    status: stats ? 'ready' : 'pending',
  };
}

function createManagedCollectionStatsErrorState(
  collectionId: string,
  error: unknown
): IndexingManagedCollectionStatsState {
  const current = useIndexingActivityStore.getState().managedCollectionStats;
  return {
    collectionId,
    error: normalizeError(error),
    stats: current.collectionId === collectionId ? current.stats : null,
    status: 'error',
  };
}

async function readQueueSnapshot(
  db: ReturnType<typeof usePGliteDatabase>
): Promise<IndexingQueueSnapshot | null> {
  if (!db || typeof db.query !== 'function') {
    return null;
  }
  const result = await db.query<QueueAggregateRow>(QUEUE_AGGREGATE_QUERY, [EMBEDDINGS_QUEUE]);
  const row = result.rows[0];
  return row ? toQueueSnapshot(row) : null;
}

function getElectronDatabaseWorkSnapshot(): (() => Promise<IndexingDatabaseWorkSnapshot>) | null {
  return getDesktopDatabaseBridge()?.schedulerSnapshot ?? null;
}

export function IndexingActivityCoordinator({
  nativeIndexSearch,
}: {
  readonly nativeIndexSearch?: IndexSearchCapability | null;
}): null {
  const native = Boolean(nativeIndexSearch);
  const appActive = useAppActive();
  const previousAppActiveRef = useRef(appActive);
  const refreshDatabaseWorkRef = useRef<(() => void) | null>(null);
  const refreshManagedCollectionStatsRef = useRef<(() => void) | null>(null);
  const refreshQueueRef = useRef<(() => void) | null>(null);
  const db = usePGliteDatabase();
  const backgroundDb = useMemo(
    () => (db && typeof db.query === 'function' ? createPriorityDbHandle(db, 'background') : db),
    [db]
  );
  const { controller } = useSharedEmbeddingRuntime();
  const setQueueSnapshot = useIndexingActivityStore((state) => state.setQueueSnapshot);
  const setBackfills = useIndexingActivityStore((state) => state.setBackfills);
  const setWorkerSnapshot = useIndexingActivityStore((state) => state.setWorkerSnapshot);
  const setBackgroundSnapshot = useIndexingActivityStore((state) => state.setBackgroundSnapshot);
  const setDatabaseWorkSnapshot = useIndexingActivityStore(
    (state) => state.setDatabaseWorkSnapshot
  );
  const setIndexingActivityError = useIndexingActivityStore(
    (state) => state.setIndexingActivityError
  );
  const setManagedCollectionStats = useIndexingActivityStore(
    (state) => state.setManagedCollectionStats
  );
  const setDurableQueueStats = useVectorStatusUIStore((state) => state.setDurableQueueStats);
  const setIsJobQueueActive = useVectorStatusUIStore((state) => state.setIsJobQueueActive);

  const backgroundEnabled = useBackgroundIndexingPreferencesStore((state) => state.enabled);
  const backgroundPaused = useBackgroundIndexingPreferencesStore((state) => state.paused);
  const configuredManagedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.managedCollectionId
  );
  const backgroundStatus = useWorkspaceCollectionSyncStatusStore((state) => ({
    lastError: state.lastError,
    managedCollectionId: state.managedCollectionId,
    managedCollectionName: state.managedCollectionName,
    pauseReasons: state.pauseReasons,
    state: state.state,
  }));

  useEffect(() => {
    const scheduler = getDatabaseWorkScheduler(db);
    if (scheduler) {
      setDatabaseWorkSnapshot(scheduler.getSnapshot());
      return scheduler.subscribe(setDatabaseWorkSnapshot);
    }

    const readElectronSnapshot = getElectronDatabaseWorkSnapshot();
    if (!readElectronSnapshot) {
      setDatabaseWorkSnapshot(null);
      return;
    }

    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const snapshot = await readElectronSnapshot();
        if (!disposed) {
          if (useIndexingActivityStore.getState().indexingActivityError !== null) {
            setIndexingActivityError(null);
          }
          setDatabaseWorkSnapshot(snapshot);
        }
      } catch (error) {
        if (!disposed) {
          setIndexingActivityError(normalizeError(error));
        }
      }
    };

    const requestRefresh = (): void => {
      void refresh();
    };
    refreshDatabaseWorkRef.current = requestRefresh;
    if (isAppActive()) {
      requestRefresh();
    }
    const interval = window.setInterval(() => {
      if (isAppActive()) {
        requestRefresh();
      }
    }, DATABASE_WORK_SNAPSHOT_POLL_MS);

    return () => {
      disposed = true;
      if (refreshDatabaseWorkRef.current === requestRefresh) {
        refreshDatabaseWorkRef.current = null;
      }
      window.clearInterval(interval);
      setDatabaseWorkSnapshot(null);
    };
  }, [db, setDatabaseWorkSnapshot, setIndexingActivityError]);

  useEffect(() => {
    if (native) {
      setQueueSnapshot(null);
      setDurableQueueStats(null);
      setIsJobQueueActive(false);
      return;
    }
    let disposed = false;

    const applyQueue = (queue: IndexingQueueSnapshot | null): void => {
      if (queue) {
        if (useIndexingActivityStore.getState().indexingActivityError !== null) {
          setIndexingActivityError(null);
        }
        setQueueSnapshot(queue);
        setDurableQueueStats({ ...queue, lastUpdated: Date.now() });
        setIsJobQueueActive(isQueueActive(queue));
        return;
      }

      setQueueSnapshot(null);
      setDurableQueueStats(null);
      setIsJobQueueActive(false);
    };

    const refresh = async (): Promise<void> => {
      try {
        const queue = await readQueueSnapshot(backgroundDb);
        if (disposed) {
          return;
        }
        applyQueue(queue);
      } catch (error) {
        if (disposed) {
          return;
        }
        setQueueSnapshot(null);
        setDurableQueueStats(null);
        setIsJobQueueActive(false);
        setIndexingActivityError(normalizeError(error));
      }
    };

    if (!backgroundDb || typeof backgroundDb.query !== 'function') {
      if (isAppActive()) {
        void refresh();
      }
      return () => {
        disposed = true;
      };
    }

    const requestRefresh = (): void => {
      void refresh();
    };
    refreshQueueRef.current = requestRefresh;
    if (isAppActive()) {
      requestRefresh();
    }
    const interval = window.setInterval(() => {
      if (isAppActive()) {
        requestRefresh();
      }
    }, QUEUE_SNAPSHOT_POLL_MS);

    return () => {
      disposed = true;
      if (refreshQueueRef.current === requestRefresh) {
        refreshQueueRef.current = null;
      }
      window.clearInterval(interval);
    };
  }, [
    native,
    backgroundDb,
    setDurableQueueStats,
    setIndexingActivityError,
    setIsJobQueueActive,
    setQueueSnapshot,
  ]);

  useEffect(() => {
    if (native) {
      setWorkerSnapshot(null);
      return;
    }
    let disposed = false;

    void controller
      .getStatus()
      .then((status) => {
        if (disposed) {
          return;
        }
        setWorkerSnapshot(toWorkerSnapshot(status));
      })
      .catch((error) => {
        if (disposed) {
          return;
        }
        setWorkerSnapshot({ lastError: normalizeError(error), state: 'error' });
      });

    const unsubscribe = controller.onStatus((status) => {
      if (disposed) {
        return;
      }
      setWorkerSnapshot(toWorkerSnapshot(status));
    });

    return () => {
      disposed = true;
      unsubscribe();
      setWorkerSnapshot(null);
    };
  }, [native, controller, setWorkerSnapshot]);

  useEffect(() => {
    if (native) {
      setBackfills([]);
      return;
    }
    let disposed = false;

    const refreshBackfills = async (): Promise<void> => {
      try {
        const inFlight = await controller.getBackfillsInFlight();
        if (disposed) {
          return;
        }
        setBackfills(inFlight.map(toBackfillSnapshot));
      } catch (error) {
        if (disposed) {
          return;
        }
        setIndexingActivityError(normalizeError(error));
      }
    };

    void refreshBackfills();
    const unsubscribe = controller.onBackfillProgress((progress) => {
      if (disposed) {
        return;
      }
      setBackfills([toProgressBackfillSnapshot(progress)]);
      void refreshBackfills();
    });

    return () => {
      disposed = true;
      unsubscribe();
      setBackfills([]);
    };
  }, [native, controller, setBackfills, setIndexingActivityError]);

  const managedCollectionId =
    backgroundStatus.managedCollectionId ?? configuredManagedCollectionId ?? null;

  const backgroundSnapshot = useMemo(
    () => ({
      enabled: backgroundEnabled,
      lastError: backgroundStatus.lastError,
      managedCollectionId,
      managedCollectionName: backgroundStatus.managedCollectionName,
      paused: backgroundPaused || backgroundStatus.state === 'paused',
      pauseReasons: backgroundStatus.pauseReasons,
      state: backgroundStatus.state,
    }),
    [
      backgroundEnabled,
      backgroundStatus.lastError,
      backgroundPaused,
      backgroundStatus.managedCollectionName,
      backgroundStatus.pauseReasons,
      backgroundStatus.state,
      managedCollectionId,
    ]
  );

  useEffect(() => {
    setBackgroundSnapshot(backgroundSnapshot);
  }, [backgroundSnapshot, setBackgroundSnapshot]);

  useEffect(() => {
    // The native provider owns these counters; PG rows describe the retired producer.
    if (native) {
      return;
    }
    if (!managedCollectionId) {
      setManagedCollectionStats({
        collectionId: null,
        error: null,
        stats: null,
        status: 'unavailable',
      });
      return;
    }

    if (!backgroundDb || typeof backgroundDb.query !== 'function') {
      setManagedCollectionStats({
        collectionId: managedCollectionId,
        error: null,
        stats: null,
        status: 'unavailable',
      });
      return;
    }

    let disposed = false;
    let refreshInFlight = false;

    setManagedCollectionStats({
      collectionId: managedCollectionId,
      error: null,
      stats: null,
      status: 'loading',
    });

    const refresh = async (): Promise<void> => {
      if (refreshInFlight) {
        return;
      }
      refreshInFlight = true;
      try {
        const state = await readManagedCollectionStats(backgroundDb, managedCollectionId);
        refreshInFlight = false;
        if (disposed) {
          return;
        }
        setManagedCollectionStats(state);
      } catch (error) {
        refreshInFlight = false;
        if (disposed) {
          return;
        }
        setManagedCollectionStats(
          createManagedCollectionStatsErrorState(managedCollectionId, error)
        );
      }
    };

    const requestRefresh = (): void => {
      void refresh();
    };
    refreshManagedCollectionStatsRef.current = requestRefresh;
    if (isAppActive()) {
      requestRefresh();
    }
    const interval = window.setInterval(() => {
      if (isAppActive()) {
        requestRefresh();
      }
    }, MANAGED_COLLECTION_STATS_POLL_MS);

    return () => {
      disposed = true;
      if (refreshManagedCollectionStatsRef.current === requestRefresh) {
        refreshManagedCollectionStatsRef.current = null;
      }
      window.clearInterval(interval);
    };
  }, [native, backgroundDb, managedCollectionId, setManagedCollectionStats]);

  useEffect(() => {
    const wasActive = previousAppActiveRef.current;
    previousAppActiveRef.current = appActive;
    if (!(appActive && !wasActive)) {
      return;
    }
    refreshDatabaseWorkRef.current?.();
    refreshQueueRef.current?.();
    refreshManagedCollectionStatsRef.current?.();
  }, [appActive]);

  return null;
}
