import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { onQueueDrained } from '@brainstrike/utils/browser-events';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEmbeddingQueueSafe } from '../embedding-queue-provider';
import type { EmbeddingRuntimeController } from './embedding-runtime-controller';
import { dispatchQueueDrainedEvent } from './queue-events';
import {
  type ApiKeyValidation,
  calculateLatency,
  EMBEDDINGS_QUEUE,
  type QueueCounts,
  type VectorQueueService,
} from './vector-queue-service';
import {
  ACTIVE_SET_QUEUE_COUNTS_QUERY,
  COVERAGE_QUERY,
  type CoverageRow,
  DEFAULT_COVERAGE,
  DEFAULT_METRICS,
  DEFAULT_QUEUE_COUNTS,
  EMBEDDINGS_QUEUE_PARAMS,
  isBackfillCancellationError,
  LAST_ERROR_QUERY,
  LATENCY_ROWS_QUERY,
  type LastErrorRow,
  type LatencyRow,
  QUEUE_COUNTS_QUERY,
  type QueueCountsRow,
  subscribeBackfillProgress,
  THROUGHPUT_QUERY,
  type ThroughputRow,
} from './vector-queue-state-queries';

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
export type ApiKeyValidationResult = ApiKeyValidation;

export interface UseVectorQueueStateResult {
  activeSetBackfilling: boolean;
  activeSetBackfillProgress: BackfillProgress;
  activeSetQueueCounts: QueueCounts;
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
  const activeBackfill = useVectorStatusUIStore((s) => s.activeBackfill);
  const durableQueueStats = useVectorStatusUIStore((s) => s.durableQueueStats);
  const isJobQueueActive = useVectorStatusUIStore((s) => s.isJobQueueActive);
  const setActiveBackfill = useVectorStatusUIStore((s) => s.setActiveBackfill);
  const setIsJobQueueActive = useVectorStatusUIStore((s) => s.setIsJobQueueActive);

  const [telemetryTrend, setTelemetryTrend] = useState<readonly TelemetryTrendPoint[]>([]);
  const [recentErrorCount, setRecentErrorCount] = useState(0);
  const autoBackfillRef = useRef<string | null>(null);
  const lastEmbeddingSetIdRef = useRef<string | null>(null);
  const backfillTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backfillRequestIdRef = useRef<string | null>(null);
  const backfillInvocationIdRef = useRef(0);

  const clearBackfillTimeout = useCallback(() => {
    if (backfillTimeoutRef.current) {
      clearTimeout(backfillTimeoutRef.current);
      backfillTimeoutRef.current = null;
    }
  }, []);
  const clearTransientBackfillState = useCallback(
    (expectedEmbeddingSetId?: string | null) => {
      const currentBackfill = useVectorStatusUIStore.getState().activeBackfill;
      if (
        expectedEmbeddingSetId &&
        currentBackfill &&
        currentBackfill.embeddingSetId !== expectedEmbeddingSetId
      ) {
        return;
      }

      clearBackfillTimeout();
      backfillRequestIdRef.current = null;
      setActiveBackfill(null);
      setIsJobQueueActive(false);
    },
    [clearBackfillTimeout, setActiveBackfill, setIsJobQueueActive]
  );
  const isBackfillActive = activeBackfill !== null;
  const backfillProgress = activeBackfill?.progress ?? null;
  const isActiveSetBackfill =
    activeBackfill !== null && activeBackfill.embeddingSetId === activeEmbeddingSetId;
  const activeSetBackfillProgress = isActiveSetBackfill ? (activeBackfill?.progress ?? null) : null;

  // Pause live queries during import, active embedding, and local backfill submission.
  // These queries invalidate on every job_queue mutation and can cause visible renderer
  // OOM during large backfills (30K+ chunks generate ~90K mutations).
  //
  // isJobQueueActive is set synchronously by setIsJobQueueActive(true) in
  // backfillActiveSet BEFORE the enqueue IPC starts, providing the earliest
  // possible signal to suppress live queries. This closes the race window
  // between the Zustand state update and React's async re-render cycle.
  const liveQueryEnabled =
    Boolean(service) &&
    !isImporting &&
    !isEmbeddingActive &&
    !isBackfillActive &&
    !isJobQueueActive;

  // Clear timeout on unmount.
  useEffect(
    () => () => {
      clearBackfillTimeout();
    },
    [clearBackfillTimeout]
  );

  const queueCountsResult = usePGliteLiveQuery<QueueCountsRow>({
    cacheKey: makeLiveQueryKey('queue-counts', EMBEDDINGS_QUEUE),
    enabled: liveQueryEnabled,
    params: EMBEDDINGS_QUEUE_PARAMS,
    query: QUEUE_COUNTS_QUERY,
  });

  const queueCounts = useMemo<QueueCounts>(() => {
    const row = queueCountsResult.rows[0];
    if (row) {
      return {
        failed: Number(row.failed ?? 0),
        queued: Number(row.queued ?? 0),
        running: Number(row.running ?? 0),
        succeeded: Number(row.succeeded ?? 0),
      };
    }
    if (durableQueueStats) {
      return {
        failed: durableQueueStats.failed,
        queued: durableQueueStats.queued,
        running: durableQueueStats.running,
        succeeded: durableQueueStats.succeeded,
      };
    }
    return DEFAULT_QUEUE_COUNTS;
  }, [durableQueueStats, queueCountsResult.rows]);

  const activeSetQueueCountsParams = useMemo<readonly [string, string] | undefined>(
    () => (activeEmbeddingSetId ? ([EMBEDDINGS_QUEUE, activeEmbeddingSetId] as const) : undefined),
    [activeEmbeddingSetId]
  );

  const activeSetQueueCountsResult = usePGliteLiveQuery<QueueCountsRow>({
    cacheKey: makeLiveQueryKey('active-set-queue-counts', activeEmbeddingSetId),
    query: ACTIVE_SET_QUEUE_COUNTS_QUERY,
    ...(activeSetQueueCountsParams ? { params: activeSetQueueCountsParams } : {}),
    enabled: liveQueryEnabled && Boolean(activeEmbeddingSetId),
  });

  const activeSetQueueCounts = useMemo<QueueCounts>(() => {
    const row = activeSetQueueCountsResult.rows[0];
    if (!row) {
      return DEFAULT_QUEUE_COUNTS;
    }
    return {
      failed: Number(row.failed ?? 0),
      queued: Number(row.queued ?? 0),
      running: Number(row.running ?? 0),
      succeeded: Number(row.succeeded ?? 0),
    };
  }, [activeSetQueueCountsResult.rows]);

  const throughputResult = usePGliteLiveQuery<ThroughputRow>({
    cacheKey: makeLiveQueryKey('throughput', EMBEDDINGS_QUEUE),
    enabled: liveQueryEnabled,
    params: EMBEDDINGS_QUEUE_PARAMS,
    query: THROUGHPUT_QUERY,
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
    enabled: liveQueryEnabled,
    params: EMBEDDINGS_QUEUE_PARAMS,
    query: LAST_ERROR_QUERY,
  });

  const lastError = useMemo(() => lastErrorResult.rows[0]?.error ?? null, [lastErrorResult.rows]);

  const latencyRowsResult = usePGliteLiveQuery<LatencyRow>({
    cacheKey: makeLiveQueryKey('latency', EMBEDDINGS_QUEUE),
    enabled: liveQueryEnabled,
    key: 'id',
    mode: 'incremental',
    params: EMBEDDINGS_QUEUE_PARAMS,
    query: LATENCY_ROWS_QUERY,
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
      activeSetQueueCountsResult.refresh(),
      throughputResult.refresh(),
      lastErrorResult.refresh(),
      latencyRowsResult.refresh(),
      coverageResult.refresh(),
    ]);
  }, [
    activeEmbeddingSetId,
    coverageResult,
    activeSetQueueCountsResult,
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
    if (!activeEmbeddingSetId) {
      return;
    }

    return onQueueDrained((detail) => {
      if (detail?.embeddingSetId && detail.embeddingSetId !== activeEmbeddingSetId) {
        return;
      }
      void refreshCoverageAndQueueState();
    });
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
        errorCount: metrics.windowErrorCount,
        latencyP95: metrics.latencyP95Ms ?? 0,
        throughput: Number.isFinite(metrics.throughputPerMinute) ? metrics.throughputPerMinute : 0,
        timestamp: Date.now(),
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
    const invocationId = backfillInvocationIdRef.current + 1;
    backfillInvocationIdRef.current = invocationId;
    clearBackfillTimeout();
    setIsJobQueueActive(true);
    const pendingRequestId = `pending:${activeEmbeddingSetId}:${Date.now()}`;
    let invocationRequestId = pendingRequestId;
    backfillRequestIdRef.current = pendingRequestId;
    setActiveBackfill({
      embeddingSetId: activeEmbeddingSetId,
      progress: null,
      requestId: pendingRequestId,
    });
    const unsubscribeProgress = subscribeBackfillProgress(
      controller,
      activeEmbeddingSetId,
      (backfill) => {
        if (backfillInvocationIdRef.current !== invocationId) {
          return;
        }
        invocationRequestId = backfill.requestId;
        backfillRequestIdRef.current = backfill.requestId;
        setActiveBackfill(backfill);
      }
    );
    try {
      logger.info('backfillActiveSet: starting backfill', { activeEmbeddingSetId });
      await controller.enqueueBackfill(activeEmbeddingSetId, {
        source: 'manual',
      });
      dispatchQueueDrainedEvent(activeEmbeddingSetId);
      logger.info('backfillActiveSet: backfill completed', { activeEmbeddingSetId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (isBackfillCancellationError(error)) {
        logger.info('backfillActiveSet: backfill canceled', {
          activeEmbeddingSetId,
          error: errorMessage,
        });
        throw error;
      }

      logger.error('backfillActiveSet: backfill failed', {
        activeEmbeddingSetId,
        error: errorMessage,
      });
      throw error;
    } finally {
      unsubscribeProgress();
      if (backfillInvocationIdRef.current === invocationId) {
        setIsJobQueueActive(false);
        clearBackfillTimeout();
        const completedRequestId = invocationRequestId;
        backfillTimeoutRef.current = setTimeout(() => {
          // Only the still-current invocation is allowed to clear visible backfill state.
          // A newer backfill increments backfillInvocationIdRef and invalidates this timeout.
          if (
            backfillInvocationIdRef.current === invocationId &&
            completedRequestId &&
            useVectorStatusUIStore.getState().activeBackfill?.requestId === completedRequestId
          ) {
            setActiveBackfill(null);
            if (backfillRequestIdRef.current === completedRequestId) {
              backfillRequestIdRef.current = null;
            }
          }
          backfillTimeoutRef.current = null;
        }, 1000);
      }
    }
  }, [
    activeEmbeddingSetId,
    clearBackfillTimeout,
    controller,
    setActiveBackfill,
    setIsJobQueueActive,
  ]);

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
      await controller.cancelAllBackfills();
      await service.wipeQueue();
      clearTransientBackfillState();
    } catch {
      // ignore errors when wiping queue
    }
  }, [clearTransientBackfillState, controller, service]);

  return useMemo(
    () => ({
      activeSetBackfilling: isActiveSetBackfill,
      activeSetBackfillProgress,
      activeSetQueueCounts,
      backfillActiveSet,
      backfilling: isBackfillActive,
      backfillProgress,
      clearQueue,
      coverage,
      lastError,
      latencyStats,
      queueCounts,
      recentErrorCount,
      retryFailed,
      telemetryTrend,
      throughput,
      validateApiKey,
      wipeQueue,
    }),
    [
      coverage,
      isActiveSetBackfill,
      activeSetBackfillProgress,
      activeSetQueueCounts,
      queueCounts,
      throughput,
      latencyStats,
      lastError,
      recentErrorCount,
      isBackfillActive,
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
