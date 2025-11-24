import { usePGliteLiveQuery } from '@brainstrike/db';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEmbeddingQueue } from '../embedding-queue-provider';
import {
  calculateLatency,
  EMBEDDINGS_QUEUE,
  type QueueCounts,
  type VectorQueueService,
} from './vector-queue-service';

export type BackfillProgress = { done: number; total: number } | null;

export interface UseVectorQueueStateParams {
  service: VectorQueueService | null;
  activeEmbeddingSetId: string | null;
  shouldAutoBackfill: boolean;
}

export interface TelemetryTrendPoint {
  readonly timestamp: number;
  readonly throughput: number;
  readonly latencyP95: number;
  readonly errorCount: number;
}

export interface UseVectorQueueStateResult {
  coverage: { total: number; withSet: number };
  queueCounts: QueueCounts;
  throughput: number;
  latencyStats: { avgMs: number; p50Ms: number; p95Ms: number };
  lastError: string | null;
  recentErrorCount: number;
  backfilling: boolean;
  backfillProgress: BackfillProgress;
  telemetryTrend: readonly TelemetryTrendPoint[];
  backfillActiveSet: () => Promise<void>;
  retryFailed: (limit?: number) => Promise<void>;
  clearQueue: () => Promise<void>;
  wipeQueue: () => Promise<void>;
}

const DEFAULT_COVERAGE: { total: number; withSet: number } = { total: 0, withSet: 0 };
const DEFAULT_QUEUE_COUNTS: QueueCounts = { queued: 0, running: 0, failed: 0, succeeded: 0 };
const EMBEDDINGS_QUEUE_PARAMS: readonly [string] = [EMBEDDINGS_QUEUE];

const QUEUE_COUNTS_QUERY = `
  SELECT
    COUNT(*) FILTER (WHERE state = 'queued')::int    AS "queued",
    COUNT(*) FILTER (WHERE state = 'running')::int   AS "running",
    COUNT(*) FILTER (WHERE state = 'failed')::int    AS "failed",
    COUNT(*) FILTER (WHERE state = 'succeeded')::int AS "succeeded"
  FROM job_queue
  WHERE queue = $1
`.trim();

const ISO_UTC_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"' as const;

const THROUGHPUT_QUERY = `
  SELECT COUNT(*)::int AS count
    FROM job_queue
   WHERE queue = $1
     AND state = 'succeeded'
     AND updated_at >= TO_CHAR(
       (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '60 seconds',
       '${ISO_UTC_FORMAT}'
     )
`.trim();

const LAST_ERROR_QUERY = `
  SELECT error
    FROM job_queue
   WHERE queue = $1
     AND state = 'failed'
ORDER BY updated_at DESC
   LIMIT 1
`.trim();

const LATENCY_ROWS_QUERY = `
  SELECT run_at AS "runAt", updated_at AS "updatedAt"
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

const COVERAGE_QUERY = `
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

type QueueCountsRow = {
  queued: number | string | null;
  running: number | string | null;
  failed: number | string | null;
  succeeded: number | string | null;
};

type ThroughputRow = { count: number | string | null };

type LastErrorRow = { error: string | null };

type LatencyRow = { runAt: string; updatedAt: string };

type CoverageRow = {
  totalChunks: number | string | null;
  chunksWithEmbeddingsForSet: number | string | null;
};

export function useVectorQueueState(params: UseVectorQueueStateParams): UseVectorQueueStateResult {
  const { activeEmbeddingSetId, shouldAutoBackfill } = params;
  const { metrics } = useEmbeddingQueue();
  const service = params.service;

  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress>(null);
  const [telemetryTrend, setTelemetryTrend] = useState<readonly TelemetryTrendPoint[]>([]);
  const [recentErrorCount, setRecentErrorCount] = useState(0);
  const autoBackfillRef = useRef<string | null>(null);
  const lastEmbeddingSetIdRef = useRef<string | null>(null);
  const backfillTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (backfillTimeoutRef.current) {
        clearTimeout(backfillTimeoutRef.current);
      }
    };
  }, []);

  const queueCountsResult = usePGliteLiveQuery<QueueCountsRow>({
    query: QUEUE_COUNTS_QUERY,
    params: EMBEDDINGS_QUEUE_PARAMS,
    enabled: Boolean(service),
  });

  const queueCounts = useMemo<QueueCounts>(() => {
    const row = queueCountsResult.rows[0];
    if (!row) {
      return DEFAULT_QUEUE_COUNTS;
    }
    return {
      queued: Number(row.queued ?? 0),
      running: Number(row.running ?? 0),
      failed: Number(row.failed ?? 0),
      succeeded: Number(row.succeeded ?? 0),
    };
  }, [queueCountsResult.rows]);

  const throughputResult = usePGliteLiveQuery<ThroughputRow>({
    query: THROUGHPUT_QUERY,
    params: EMBEDDINGS_QUEUE_PARAMS,
    enabled: Boolean(service),
  });

  const throughput = useMemo(() => {
    const row = throughputResult.rows[0];
    if (row && row.count !== null && row.count !== undefined) {
      return Number(row.count);
    }
    return 0;
  }, [throughputResult.rows]);

  const lastErrorResult = usePGliteLiveQuery<LastErrorRow>({
    query: LAST_ERROR_QUERY,
    params: EMBEDDINGS_QUEUE_PARAMS,
    enabled: Boolean(service),
  });

  const lastError = useMemo(() => lastErrorResult.rows[0]?.error ?? null, [lastErrorResult.rows]);

  const latencyRowsResult = usePGliteLiveQuery<LatencyRow>({
    query: LATENCY_ROWS_QUERY,
    params: EMBEDDINGS_QUEUE_PARAMS,
    enabled: Boolean(service),
  });

  const latencyStatsFromQuery = useMemo(() => {
    if (!latencyRowsResult.rows.length) {
      return null;
    }
    return calculateLatency(
      latencyRowsResult.rows.map((row) => ({ runAt: row.runAt, updatedAt: row.updatedAt }))
    );
  }, [latencyRowsResult.rows]);

  const latencyStats = useMemo(() => {
    if (latencyStatsFromQuery) {
      return latencyStatsFromQuery;
    }
    return {
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
    };
  }, [latencyStatsFromQuery]);

  const coverageParams = useMemo<readonly [string] | undefined>(
    () => (activeEmbeddingSetId ? ([activeEmbeddingSetId] as const) : undefined),
    [activeEmbeddingSetId]
  );

  const coverageResult = usePGliteLiveQuery<CoverageRow>({
    query: COVERAGE_QUERY,
    ...(coverageParams ? { params: coverageParams } : {}),
    enabled: Boolean(service && activeEmbeddingSetId),
  });

  const coverage = useMemo(() => {
    if (!activeEmbeddingSetId) {
      return DEFAULT_COVERAGE;
    }
    const row = coverageResult.rows[0];
    if (!row) {
      return DEFAULT_COVERAGE;
    }
    return {
      total: Number(row.totalChunks ?? 0),
      withSet: Number(row.chunksWithEmbeddingsForSet ?? 0),
    };
  }, [activeEmbeddingSetId, coverageResult.rows]);

  useEffect(() => {
    setRecentErrorCount(metrics.windowErrorCount);
  }, [metrics.windowErrorCount]);

  useEffect(() => {
    if (lastEmbeddingSetIdRef.current === activeEmbeddingSetId) {
      return;
    }
    lastEmbeddingSetIdRef.current = activeEmbeddingSetId;
    autoBackfillRef.current = null;
  }, [activeEmbeddingSetId]);

  useEffect(() => {
    if (!activeEmbeddingSetId) {
      autoBackfillRef.current = null;
      return;
    }
    if (coverage.total === 0) {
      autoBackfillRef.current = null;
      return;
    }
    if (coverage.withSet >= coverage.total) {
      autoBackfillRef.current = null;
    }
  }, [activeEmbeddingSetId, coverage.total, coverage.withSet]);

  useEffect(() => {
    setTelemetryTrend((prev) => {
      const nextPoint: TelemetryTrendPoint = {
        timestamp: Date.now(),
        throughput: Number.isFinite(metrics.throughputPerMinute) ? metrics.throughputPerMinute : 0,
        latencyP95: metrics.latencyP95Ms ?? 0,
        errorCount: metrics.windowErrorCount,
      };
      const lastPoint = prev.at(-1);
      if (
        lastPoint &&
        lastPoint.throughput === nextPoint.throughput &&
        lastPoint.latencyP95 === nextPoint.latencyP95 &&
        lastPoint.errorCount === nextPoint.errorCount
      ) {
        return prev;
      }
      const nextHistory = [...prev, nextPoint];
      if (nextHistory.length > 60) {
        return nextHistory.slice(-60);
      }
      return nextHistory;
    });
  }, [metrics]);

  const backfillActiveSet = useCallback(async () => {
    if (!service || !activeEmbeddingSetId) return;
    setBackfilling(true);
    setBackfillProgress(null);
    try {
      await service.backfill(activeEmbeddingSetId, (done, total) => {
        setBackfillProgress({ done, total });
      });
    } catch {
      // swallow errors; live queries will reflect queue changes
    } finally {
      setBackfilling(false);
      if (backfillTimeoutRef.current) {
        clearTimeout(backfillTimeoutRef.current);
      }
      backfillTimeoutRef.current = setTimeout(() => {
        setBackfillProgress(null);
        backfillTimeoutRef.current = null;
      }, 1000);
    }
  }, [service, activeEmbeddingSetId]);

  useEffect(() => {
    if (!shouldAutoBackfill || !activeEmbeddingSetId) return;
    if (backfilling) return;
    if (!coverage.total) return;
    if (coverage.withSet >= coverage.total) return;
    if (autoBackfillRef.current === activeEmbeddingSetId) return;

    autoBackfillRef.current = activeEmbeddingSetId;
    void backfillActiveSet();
  }, [
    shouldAutoBackfill,
    activeEmbeddingSetId,
    backfilling,
    coverage.total,
    coverage.withSet,
    backfillActiveSet,
  ]);

  const retryFailed = useCallback(
    async (limit = 20) => {
      if (!service) return;
      try {
        await service.retryFailed(limit);
      } catch {
        // ignore errors from manual retries
      }
    },
    [service]
  );

  const clearQueue = useCallback(async () => {
    if (!service) return;
    try {
      await service.clearQueue(['failed']);
    } catch {
      // ignore errors when clearing queue
    }
  }, [service]);

  const wipeQueue = useCallback(async () => {
    if (!service) return;
    try {
      await service.wipeQueue();
    } catch {
      // ignore errors when wiping queue
    }
  }, [service]);

  return useMemo(
    () => ({
      coverage,
      queueCounts,
      throughput,
      latencyStats,
      lastError,
      recentErrorCount,
      backfilling,
      backfillProgress,
      telemetryTrend,
      backfillActiveSet,
      retryFailed,
      clearQueue,
      wipeQueue,
    }),
    [
      coverage,
      queueCounts,
      throughput,
      latencyStats,
      lastError,
      recentErrorCount,
      backfilling,
      backfillProgress,
      telemetryTrend,
      backfillActiveSet,
      retryFailed,
      clearQueue,
      wipeQueue,
    ]
  );
}
