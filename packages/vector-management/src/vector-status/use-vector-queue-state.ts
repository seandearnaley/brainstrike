import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db';
import {
  type ActiveBackfillState,
  useVectorStatusUIStore,
} from '@brainstrike/preferences/stores/vector-status-ui-store';
import { createLogger } from '@brainstrike/utils/logger';
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

const ACTIVE_SET_QUEUE_COUNTS_QUERY = `
  SELECT
    COUNT(*) FILTER (WHERE state = 'queued')::int    AS "queued",
    COUNT(*) FILTER (WHERE state = 'running')::int   AS "running",
    COUNT(*) FILTER (WHERE state = 'failed')::int    AS "failed",
    COUNT(*) FILTER (WHERE state = 'succeeded')::int AS "succeeded"
  FROM job_queue
  WHERE queue = $1
    AND job_type = 'embed_chunk'
    AND payload->>'embeddingSetId' = $2
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
  id: string;
  runAt: string;
  updatedAt: string;
}

interface CoverageRow {
  chunksWithEmbeddingsForSet: number | string | null;
  totalChunks: number | string | null;
}

// Default metrics when EmbeddingQueueProvider is not available
const DEFAULT_METRICS = {
  windowErrorCount: 0,
  throughputPerMinute: 0,
  latencyP95Ms: 0,
} as const;

function isBackfillCancellationError(error: unknown): boolean {
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
function createBackfillCancellationError(): Error {
  const error = new Error('Embedding backfill was canceled.');
  error.name = 'AbortError';
  return error;
}

function subscribeBackfillProgress(
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
      requestId: progress.requestId,
      progress: { done: progress.current, total: progress.total },
    });
  });
}

function shouldClearRecoveredBackfillState(
  currentBackfill: ActiveBackfillState | null,
  activeEmbeddingSetId: string,
  isJobQueueActive: boolean
): boolean {
  return (
    currentBackfill?.embeddingSetId === activeEmbeddingSetId &&
    (isJobQueueActive || currentBackfill.requestId.startsWith('recovered:'))
  );
}

function shouldSkipRecoveredBackfillRestore(
  currentBackfill: ActiveBackfillState | null,
  activeEmbeddingSetId: string
): boolean {
  return (
    currentBackfill?.embeddingSetId === activeEmbeddingSetId &&
    !currentBackfill.requestId.startsWith('recovered:')
  );
}

function createRecoveredBackfillState(activeEmbeddingSetId: string): ActiveBackfillState {
  return {
    embeddingSetId: activeEmbeddingSetId,
    requestId: `recovered:${activeEmbeddingSetId}:${Date.now()}`,
    progress: null,
  };
}

interface ReconcileBackfillStateAfterReloadParams {
  activeEmbeddingSetId: string;
  cleanupRecoveryRef: React.MutableRefObject<(() => void) | null>;
  clearTransientBackfillState: (expectedEmbeddingSetId?: string | null) => void;
  controller: EmbeddingRuntimeController;
  isCancelled: () => boolean;
  markCancelled: () => void;
  setActiveBackfill: (backfill: ActiveBackfillState | null) => void;
  setIsJobQueueActive: (active: boolean) => void;
}

async function reconcileBackfillStateAfterReload({
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
  const cleanupRecoveryRef = useRef<(() => void) | null>(null);

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
  const isDesktopRenderer =
    typeof window !== 'undefined' &&
    (window as Window & { electronAPI?: unknown }).electronAPI !== undefined;

  // Clear timeout on unmount.
  useEffect(
    () => () => {
      clearBackfillTimeout();
    },
    [clearBackfillTimeout]
  );

  // Reconcile backfill state after renderer reload (e.g., crash recovery).
  // If the main process has a backfill in flight for the active embedding set,
  // re-attach to the progress stream so the UI shows the progress indicator.
  useEffect(() => {
    if (!(activeEmbeddingSetId && isDesktopRenderer)) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await reconcileBackfillStateAfterReload({
          activeEmbeddingSetId,
          clearTransientBackfillState,
          cleanupRecoveryRef,
          controller,
          isCancelled: () => cancelled,
          markCancelled: () => {
            cancelled = true;
          },
          setActiveBackfill,
          setIsJobQueueActive,
        });
      } catch (error) {
        logger.warn('Failed to reconcile backfill state after reload', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
      cleanupRecoveryRef.current?.();
      cleanupRecoveryRef.current = null;
    };
  }, [
    activeEmbeddingSetId,
    clearTransientBackfillState,
    controller,
    isDesktopRenderer,
    setActiveBackfill,
    setIsJobQueueActive,
  ]);

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
      queued: Number(row.queued ?? 0),
      running: Number(row.running ?? 0),
      failed: Number(row.failed ?? 0),
      succeeded: Number(row.succeeded ?? 0),
    };
  }, [activeSetQueueCountsResult.rows]);

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
    mode: 'incremental',
    key: 'id',
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
    if (typeof window === 'undefined' || !activeEmbeddingSetId) {
      return;
    }

    const handleQueueDrained = (event: Event) => {
      const detail = (event as CustomEvent<{ embeddingSetId?: string | null } | undefined>).detail;
      if (detail?.embeddingSetId && detail.embeddingSetId !== activeEmbeddingSetId) {
        return;
      }
      void refreshCoverageAndQueueState();
      // The drained job may have populated a "recovered" backfill (desktop reconcile
      // path) whose only other clear point is a remount. If we don't clear it here,
      // the recovered state — and any UI keyed off it — stays stranded until reload.
      // A genuine in-flight backfill keeps a non-`recovered:` requestId and is left to
      // its own completion path, so it survives drained-between-batches events.
      const current = useVectorStatusUIStore.getState().activeBackfill;
      if (
        current?.embeddingSetId === activeEmbeddingSetId &&
        current.requestId.startsWith('recovered:')
      ) {
        clearTransientBackfillState(activeEmbeddingSetId);
      }
    };

    window.addEventListener('brainstrike:queue-drained', handleQueueDrained);
    return () => {
      window.removeEventListener('brainstrike:queue-drained', handleQueueDrained);
    };
  }, [activeEmbeddingSetId, clearTransientBackfillState, refreshCoverageAndQueueState]);

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
    const invocationId = backfillInvocationIdRef.current + 1;
    backfillInvocationIdRef.current = invocationId;
    clearBackfillTimeout();
    setIsJobQueueActive(true);
    const pendingRequestId = `pending:${activeEmbeddingSetId}:${Date.now()}`;
    let invocationRequestId = pendingRequestId;
    backfillRequestIdRef.current = pendingRequestId;
    setActiveBackfill({
      embeddingSetId: activeEmbeddingSetId,
      requestId: pendingRequestId,
      progress: null,
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
      const enqueueResult = await controller.enqueueBackfill(activeEmbeddingSetId, {
        source: 'manual',
      });
      // Desktop main resolves { canceled: true } for a deliberate cancellation
      // instead of rejecting (a rejection logs "Error occurred in handler"). A
      // canceled backfill is NOT a completion — re-raise it as an abort so the
      // catch's cancellation branch handles it (no queue-drained, no "completed").
      // The local/web controller resolves { requestId } (and progress-only
      // controllers may resolve nothing), so guard the membership check.
      if (enqueueResult && 'canceled' in enqueueResult) {
        throw createBackfillCancellationError();
      }
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
      coverage,
      activeSetBackfilling: isActiveSetBackfill,
      activeSetBackfillProgress,
      activeSetQueueCounts,
      queueCounts,
      throughput,
      latencyStats,
      lastError,
      recentErrorCount,
      backfilling: isBackfillActive,
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
