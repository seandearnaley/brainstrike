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
