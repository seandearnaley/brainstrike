import {
  createPriorityDbHandle,
  getDatabaseWorkScheduler,
  usePGliteDatabase,
} from '@brainstrike/db';
import {
  type IndexingBackfillSnapshot,
  type IndexingDatabaseWorkSnapshot,
  type IndexingQueueSnapshot,
  type IndexingWorkerSnapshot,
  useBackgroundIndexingPreferencesStore,
  useIndexingActivityStore,
  useVectorStatusUIStore,
  useWorkspaceCollectionSyncStatusStore,
} from '@brainstrike/preferences';
import { useEffect, useMemo } from 'react';
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
  if (typeof window === 'undefined') {
    return null;
  }
  return window.electronAPI?.db?.schedulerSnapshot ?? null;
}

export function IndexingActivityCoordinator(): null {
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
          setIndexingActivityError(null);
          setDatabaseWorkSnapshot(snapshot);
        }
      } catch (error) {
        if (!disposed) {
          setIndexingActivityError(normalizeError(error));
        }
      }
    };

    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, DATABASE_WORK_SNAPSHOT_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      setDatabaseWorkSnapshot(null);
    };
  }, [db, setDatabaseWorkSnapshot, setIndexingActivityError]);

  useEffect(() => {
    let disposed = false;

    const applyQueue = (queue: IndexingQueueSnapshot | null): void => {
      if (queue) {
        setIndexingActivityError(null);
        setQueueSnapshot(queue);
        setDurableQueueStats(queue);
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

    void refresh();
    if (!backgroundDb || typeof backgroundDb.query !== 'function') {
      return () => {
        disposed = true;
      };
    }

    const interval = window.setInterval(() => {
      void refresh();
    }, QUEUE_SNAPSHOT_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [
    backgroundDb,
    setDurableQueueStats,
    setIndexingActivityError,
    setIsJobQueueActive,
    setQueueSnapshot,
  ]);

  useEffect(() => {
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
  }, [controller, setWorkerSnapshot]);

  useEffect(() => {
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
  }, [controller, setBackfills, setIndexingActivityError]);

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

  return null;
}
