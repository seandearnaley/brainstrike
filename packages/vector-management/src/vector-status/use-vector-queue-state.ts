import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db';
import { useVectorStatusUIStore } from '@brainstrike/preferences';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEmbeddingQueueSafe } from '../embedding-queue-provider';
import type { EmbeddingRuntimeController } from './embedding-runtime-controller';
import {
  calculateLatency,
  EMBEDDINGS_QUEUE,
  type QueueCounts,
  type VectorQueueService,
} from './vector-queue-service';

const logger = createLogger('useVectorQueueState');

export type BackfillProgress = { done: number; total: number } | null;

export interface UseVectorQueueStateParams {
  activeEmbeddingSetId: string | null;
  controller: EmbeddingRuntimeController;
  /** When true, live queries are paused to avoid performance degradation during embedding generation */
  isEmbeddingActive?: boolean;
  /** When true, live queries are paused to avoid performance degradation during bulk operations */
  isImporting?: boolean;
  service: VectorQueueService | null;
  shouldAutoBackfill: boolean;
}

export interface TelemetryTrendPoint {
  readonly errorCount: number;
  readonly latencyP95: number;
  readonly throughput: number;
  readonly timestamp: number;
}

/**
 * Result of API key validation before backfill
 */
export type ApiKeyValidationResult = { valid: true } | { valid: false; message: string };

export interface UseVectorQueueStateResult {
  backfillActiveSet: () => Promise<void>;
  backfilling: boolean;
  backfillProgress: BackfillProgress;
  clearQueue: () => Promise<void>;
  coverage: { total: number; withSet: number };
  lastError: string | null;
  latencyStats: { avgMs: number; p50Ms: number; p95Ms: number };
  queueCounts: QueueCounts;
  recentErrorCount: number;
  retryFailed: (limit?: number) => Promise<void>;
  telemetryTrend: readonly TelemetryTrendPoint[];
  throughput: number;
  /**
   * Validates that the API key is available for the active embedding set's model.
   * Call this before backfillActiveSet to show a helpful error if the API key is missing.
   */
  validateApiKey: () => Promise<ApiKeyValidationResult>;
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

interface QueueCountsRow {
  failed: number | string | null;
  queued: number | string | null;
  running: number | string | null;
  succeeded: number | string | null;
}

interface ThroughputRow {
  count: number | string | null;
}

interface LastErrorRow {
  error: string | null;
}

interface LatencyRow {
  runAt: string;
  updatedAt: string;
}

interface CoverageRow {
  chunksWithEmbeddingsForSet: number | string | null;
  totalChunks: number | string | null;
}

function dispatchQueueDrainedEvent(embeddingSetId: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent('brainstrike:queue-drained', {
      detail: { embeddingSetId, queue: EMBEDDINGS_QUEUE },
    })
  );
}

// Default metrics when EmbeddingQueueProvider is not available
const DEFAULT_METRICS = {
  windowErrorCount: 0,
  throughputPerMinute: 0,
  latencyP95Ms: 0,
} as const;

function subscribeBackfillProgress(
  controller: EmbeddingRuntimeController,
  activeEmbeddingSetId: string,
  setBackfillProgress: (progress: BackfillProgress) => void
): () => void {
  return controller.onBackfillProgress((progress) => {
    if (progress.embeddingSetId !== activeEmbeddingSetId) {
      return;
    }
    setBackfillProgress({ done: progress.current, total: progress.total });
  });
}

export function useVectorQueueState(params: UseVectorQueueStateParams): UseVectorQueueStateResult {
  // shouldAutoBackfill is retained in the API for future use but currently has no effect
  const {
    activeEmbeddingSetId,
    shouldAutoBackfill: _shouldAutoBackfill,
    isImporting = false,
    isEmbeddingActive = false,
  } = params;
  // Use safe version that returns null when no provider is present
  const embeddingQueueContext = useEmbeddingQueueSafe();
  const metrics = embeddingQueueContext?.metrics ?? DEFAULT_METRICS;
  const service = params.service;
  const controller = params.controller;
  const durableQueueStats = useVectorStatusUIStore((s) => s.durableQueueStats);
  const setIsJobQueueActive = useVectorStatusUIStore((s) => s.setIsJobQueueActive);

  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress>(null);
  const [telemetryTrend, setTelemetryTrend] = useState<readonly TelemetryTrendPoint[]>([]);
  const [recentErrorCount, setRecentErrorCount] = useState(0);
  const autoBackfillRef = useRef<string | null>(null);
  const lastEmbeddingSetIdRef = useRef<string | null>(null);
  const backfillTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pause live queries during import, active embedding, and local backfill submission.
  // These queries invalidate on every job_queue mutation and can cause visible renderer
  // hitching while large backfills are being enqueued.
  const liveQueryEnabled = Boolean(service) && !isImporting && !isEmbeddingActive && !backfilling;

  // Clear timeout on unmount
  // biome-ignore lint/plugin: Cleanup timeout on unmount - standard cleanup pattern
  useEffect(
    () => () => {
      if (backfillTimeoutRef.current) {
        clearTimeout(backfillTimeoutRef.current);
      }
    },
    []
  );

  const queueCountsResult = usePGliteLiveQuery<QueueCountsRow>({
    cacheKey: makeLiveQueryKey('queue-counts', EMBEDDINGS_QUEUE),
    query: QUEUE_COUNTS_QUERY,
    params: EMBEDDINGS_QUEUE_PARAMS,
    enabled: liveQueryEnabled,
  });

  const queueCounts = useMemo<QueueCounts>(() => {
    const row = queueCountsResult.rows[0];
    if (row) {
      return {
        queued: Number(row.queued ?? 0),
        running: Number(row.running ?? 0),
        failed: Number(row.failed ?? 0),
        succeeded: Number(row.succeeded ?? 0),
      };
    }
    if (durableQueueStats) {
      return {
        queued: durableQueueStats.queued,
        running: durableQueueStats.running,
        failed: durableQueueStats.failed,
        succeeded: durableQueueStats.succeeded,
      };
    }
    return DEFAULT_QUEUE_COUNTS;
  }, [durableQueueStats, queueCountsResult.rows]);

  const throughputResult = usePGliteLiveQuery<ThroughputRow>({
    cacheKey: makeLiveQueryKey('throughput', EMBEDDINGS_QUEUE),
    query: THROUGHPUT_QUERY,
    params: EMBEDDINGS_QUEUE_PARAMS,
    enabled: liveQueryEnabled,
  });

  const throughput = useMemo(() => {
    const row = throughputResult.rows[0];
    if (row && row.count !== null && row.count !== undefined) {
      return Number(row.count);
    }
    return Number.isFinite(metrics.throughputPerMinute) ? metrics.throughputPerMinute : 0;
  }, [metrics.throughputPerMinute, throughputResult.rows]);

  const lastErrorResult = usePGliteLiveQuery<LastErrorRow>({
    cacheKey: makeLiveQueryKey('last-error', EMBEDDINGS_QUEUE),
    query: LAST_ERROR_QUERY,
    params: EMBEDDINGS_QUEUE_PARAMS,
    enabled: liveQueryEnabled,
  });

  const lastError = useMemo(() => lastErrorResult.rows[0]?.error ?? null, [lastErrorResult.rows]);

  const latencyRowsResult = usePGliteLiveQuery<LatencyRow>({
    cacheKey: makeLiveQueryKey('latency', EMBEDDINGS_QUEUE),
    query: LATENCY_ROWS_QUERY,
    params: EMBEDDINGS_QUEUE_PARAMS,
    enabled: liveQueryEnabled,
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
    cacheKey: makeLiveQueryKey('coverage', activeEmbeddingSetId),
    query: COVERAGE_QUERY,
    ...(coverageParams ? { params: coverageParams } : {}),
    enabled: liveQueryEnabled && Boolean(activeEmbeddingSetId),
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

  const refreshCoverageAndQueueState = useCallback(async () => {
    if (!activeEmbeddingSetId) {
      return;
    }
    await Promise.all([
      queueCountsResult.refresh(),
      throughputResult.refresh(),
      lastErrorResult.refresh(),
      latencyRowsResult.refresh(),
      coverageResult.refresh(),
    ]);
  }, [
    activeEmbeddingSetId,
    coverageResult,
    lastErrorResult,
    latencyRowsResult,
    queueCountsResult,
    throughputResult,
  ]);

  const previousLiveQueryEnabledRef = useRef(liveQueryEnabled);

  useEffect(() => {
    const wasEnabled = previousLiveQueryEnabledRef.current;
    previousLiveQueryEnabledRef.current = liveQueryEnabled;
    if (!(liveQueryEnabled && !wasEnabled)) {
      return;
    }
    void refreshCoverageAndQueueState();
  }, [liveQueryEnabled, refreshCoverageAndQueueState]);

  useEffect(() => {
    if (typeof window === 'undefined' || !activeEmbeddingSetId) {
      return;
    }

    const handleQueueDrained = (event: Event) => {
      const detail = (event as CustomEvent<{ embeddingSetId?: string | null } | undefined>).detail;
      if (detail?.embeddingSetId && detail.embeddingSetId !== activeEmbeddingSetId) {
        return;
      }
      void refreshCoverageAndQueueState();
    };

    window.addEventListener('brainstrike:queue-drained', handleQueueDrained);
    return () => {
      window.removeEventListener('brainstrike:queue-drained', handleQueueDrained);
    };
  }, [activeEmbeddingSetId, refreshCoverageAndQueueState]);

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
    if (!activeEmbeddingSetId) {
      throw new Error('No active embedding set selected.');
    }
    setBackfilling(true);
    setIsJobQueueActive(true);
    setBackfillProgress(null);
    const unsubscribeProgress = subscribeBackfillProgress(
      controller,
      activeEmbeddingSetId,
      setBackfillProgress
    );
    try {
      logger.info('backfillActiveSet: starting backfill', { activeEmbeddingSetId });
      await controller.enqueueBackfill(activeEmbeddingSetId);
      dispatchQueueDrainedEvent(activeEmbeddingSetId);
      logger.info('backfillActiveSet: backfill completed', { activeEmbeddingSetId });
    } catch (error) {
      // Log errors instead of swallowing them silently
      logger.error('backfillActiveSet: backfill failed', {
        activeEmbeddingSetId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      unsubscribeProgress();
      setBackfilling(false);
      setIsJobQueueActive(false);
      if (backfillTimeoutRef.current) {
        clearTimeout(backfillTimeoutRef.current);
      }
      backfillTimeoutRef.current = setTimeout(() => {
        setBackfillProgress(null);
        backfillTimeoutRef.current = null;
      }, 1000);
    }
  }, [activeEmbeddingSetId, controller, setIsJobQueueActive]);

  const validateApiKey = useCallback(async (): Promise<ApiKeyValidationResult> => {
    if (!(service && activeEmbeddingSetId)) {
      return { valid: true }; // Let other validation handle missing service/set
    }
    return service.validateApiKeyForSet(activeEmbeddingSetId);
  }, [service, activeEmbeddingSetId]);

  // Note: Auto-backfill effect was removed - backfill must be triggered manually
  // via the Backfill button in Vector Status. This gives users explicit control
  // over when embedding jobs are enqueued. The shouldAutoBackfill parameter is
  // retained in the API for future use but currently has no effect.

  const retryFailed = useCallback(
    async (limit = 20) => {
      if (!service) {
        return;
      }
      try {
        await service.retryFailed(limit);
      } catch {
        // ignore errors from manual retries
      }
    },
    [service]
  );

  const clearQueue = useCallback(async () => {
    if (!service) {
      return;
    }
    try {
      await service.clearQueue(['failed']);
    } catch {
      // ignore errors when clearing queue
    }
  }, [service]);

  const wipeQueue = useCallback(async () => {
    if (!service) {
      return;
    }
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
      validateApiKey,
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
      validateApiKey,
      backfillActiveSet,
      retryFailed,
      clearQueue,
      wipeQueue,
    ]
  );
}
