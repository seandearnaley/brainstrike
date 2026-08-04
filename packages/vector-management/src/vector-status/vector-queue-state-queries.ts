import {
  type ActiveBackfillState,
  useVectorStatusUIStore,
} from '@brainstrike/app-state/stores/vector-status-ui-store';
import type { EmbeddingRuntimeController } from './embedding-runtime-controller';
import type { BackfillProgress } from './use-vector-queue-state';
import { EMBEDDINGS_QUEUE, type QueueCounts } from './vector-queue-service';

export const DEFAULT_COVERAGE: { total: number; withSet: number } = { total: 0, withSet: 0 };
export const DEFAULT_QUEUE_COUNTS: QueueCounts = { failed: 0, queued: 0, running: 0, succeeded: 0 };
export const EMBEDDINGS_QUEUE_PARAMS: readonly [string] = [EMBEDDINGS_QUEUE];

export const QUEUE_COUNTS_QUERY = `
  SELECT
    COUNT(*) FILTER (WHERE state = 'queued')::int    AS "queued",
    COUNT(*) FILTER (WHERE state = 'running')::int   AS "running",
    COUNT(*) FILTER (WHERE state = 'failed')::int    AS "failed",
    COUNT(*) FILTER (WHERE state = 'succeeded')::int AS "succeeded"
  FROM job_queue
  WHERE queue = $1
`.trim();

export const ACTIVE_SET_QUEUE_COUNTS_QUERY = `
  SELECT
    COUNT(*) FILTER (WHERE state = 'queued')::int    AS "queued",
    COUNT(*) FILTER (WHERE state = 'running')::int   AS "running",
    COUNT(*) FILTER (WHERE state = 'failed')::int    AS "failed",
    COUNT(*) FILTER (WHERE state = 'succeeded')::int AS "succeeded"
  FROM job_queue
  WHERE queue = $1
    AND job_type = 'embed_chunk'
    AND embedding_set_id = $2
`.trim();

export const ISO_UTC_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"' as const;

export const THROUGHPUT_QUERY = `
  SELECT COUNT(*)::int AS count
    FROM job_queue
   WHERE queue = $1
     AND state = 'succeeded'
     AND updated_at >= TO_CHAR(
       (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '60 seconds',
       '${ISO_UTC_FORMAT}'
     )
`.trim();

export const LAST_ERROR_QUERY = `
  SELECT error
    FROM job_queue
   WHERE queue = $1
     AND state = 'failed'
ORDER BY updated_at DESC
   LIMIT 1
`.trim();

export const LATENCY_ROWS_QUERY = `
  SELECT id, run_at AS "runAt", updated_at AS "updatedAt"
    FROM job_queue
   WHERE queue = $1
     AND state = 'succeeded'
     AND updated_at >= TO_CHAR(
       (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '5 minutes',
       '${ISO_UTC_FORMAT}'
     )
ORDER BY updated_at DESC
   LIMIT 200
`.trim();

export const COVERAGE_QUERY = `
  WITH target AS (SELECT $1::text AS embedding_set_id)
  SELECT
    COUNT(*)::int AS "totalChunks",
    COUNT(*) FILTER (
      WHERE (
        c.embedding_set_id = target.embedding_set_id
        OR (c.embedding_set_id IS NULL AND fr.embedding_set_id = target.embedding_set_id)
      )
      AND c.embedding IS NOT NULL
    )::int AS "chunksWithEmbeddingsForSet"
  FROM file_chunks c
  JOIN file_records fr ON fr.id = c.file_record_id
  JOIN target ON fr.embedding_set_id = target.embedding_set_id
`.trim();

export interface QueueCountsRow {
  failed: number | string | null;
  queued: number | string | null;
  running: number | string | null;
  succeeded: number | string | null;
}

export interface ThroughputRow {
  count: number | string | null;
}

export interface LastErrorRow {
  error: string | null;
}

export interface LatencyRow {
  id: string;
  runAt: string;
  updatedAt: string;
}

export interface CoverageRow {
  chunksWithEmbeddingsForSet: number | string | null;
  totalChunks: number | string | null;
}

// Default metrics when EmbeddingQueueProvider is not available
export const DEFAULT_METRICS = {
  latencyP95Ms: 0,
  throughputPerMinute: 0,
  windowErrorCount: 0,
} as const;

export function isBackfillCancellationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'AbortError';
}

/**
 * Build a cancellation error recognized by isBackfillCancellationError (name ===
 * 'AbortError'). Used to re-raise a desktop `{ canceled: true }` enqueue result so
 * a deliberately-canceled backfill is handled identically to a local AbortSignal
 * cancel — never reported as a completion.
 */
export function createBackfillCancellationError(): Error {
  const error = new Error('Embedding backfill was canceled.');
  error.name = 'AbortError';
  return error;
}

export function subscribeBackfillProgress(
  controller: EmbeddingRuntimeController,
  activeEmbeddingSetId: string,
  setActiveBackfill: (backfill: {
    embeddingSetId: string;
    progress: NonNullable<BackfillProgress>;
    requestId: string;
  }) => void
): () => void {
  return controller.onBackfillProgress((progress) => {
    if (progress.embeddingSetId !== activeEmbeddingSetId) {
      return;
    }
    setActiveBackfill({
      embeddingSetId: progress.embeddingSetId,
      progress: { done: progress.current, total: progress.total },
      requestId: progress.requestId,
    });
  });
}

export function shouldClearRecoveredBackfillState(
  currentBackfill: ActiveBackfillState | null,
  activeEmbeddingSetId: string,
  isJobQueueActive: boolean
): boolean {
  return (
    currentBackfill?.embeddingSetId === activeEmbeddingSetId &&
    (isJobQueueActive || currentBackfill.requestId.startsWith('recovered:'))
  );
}

export function shouldSkipRecoveredBackfillRestore(
  currentBackfill: ActiveBackfillState | null,
  activeEmbeddingSetId: string
): boolean {
  return (
    currentBackfill?.embeddingSetId === activeEmbeddingSetId &&
    !currentBackfill.requestId.startsWith('recovered:')
  );
}

export function createRecoveredBackfillState(activeEmbeddingSetId: string): ActiveBackfillState {
  return {
    embeddingSetId: activeEmbeddingSetId,
    progress: null,
    requestId: `recovered:${activeEmbeddingSetId}:${Date.now()}`,
  };
}

export interface ReconcileBackfillStateAfterReloadParams {
  activeEmbeddingSetId: string;
  cleanupRecoveryRef: React.MutableRefObject<(() => void) | null>;
  clearTransientBackfillState: (expectedEmbeddingSetId?: string | null) => void;
  controller: EmbeddingRuntimeController;
  isCancelled: () => boolean;
  markCancelled: () => void;
  setActiveBackfill: (backfill: ActiveBackfillState | null) => void;
  setIsJobQueueActive: (active: boolean) => void;
}

export async function reconcileBackfillStateAfterReload({
  activeEmbeddingSetId,
  clearTransientBackfillState,
  cleanupRecoveryRef,
  controller,
  isCancelled,
  markCancelled,
  setActiveBackfill,
  setIsJobQueueActive,
}: ReconcileBackfillStateAfterReloadParams): Promise<void> {
  const inFlight = await controller.getBackfillsInFlight();
  if (isCancelled()) {
    return;
  }

  if (!inFlight.some((backfill) => backfill.embeddingSetId === activeEmbeddingSetId)) {
    const currentState = useVectorStatusUIStore.getState();
    if (
      shouldClearRecoveredBackfillState(
        currentState.activeBackfill,
        activeEmbeddingSetId,
        currentState.isJobQueueActive
      )
    ) {
      clearTransientBackfillState(activeEmbeddingSetId);
    }
    return;
  }

  const currentBackfill = useVectorStatusUIStore.getState().activeBackfill;
  if (shouldSkipRecoveredBackfillRestore(currentBackfill, activeEmbeddingSetId)) {
    return;
  }

  setIsJobQueueActive(true);
  setActiveBackfill(createRecoveredBackfillState(activeEmbeddingSetId));

  const unsubscribe = subscribeBackfillProgress(
    controller,
    activeEmbeddingSetId,
    (backfill: {
      embeddingSetId: string;
      progress: NonNullable<BackfillProgress>;
      requestId: string;
    }) => {
      if (isCancelled()) {
        return;
      }
      setActiveBackfill(backfill);
    }
  );

  cleanupRecoveryRef.current = () => {
    markCancelled();
    unsubscribe();
  };
}
