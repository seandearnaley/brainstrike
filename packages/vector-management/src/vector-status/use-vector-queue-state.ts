import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEmbeddingQueue } from '../embedding-queue-provider';
import {
  handleQueueStateChange,
  type QueueCounts,
  type VectorQueueService,
} from './vector-queue-service';

export type BackfillProgress = { done: number; total: number } | null;

export interface UseVectorQueueStateParams {
  service: VectorQueueService | null;
  activeEmbeddingSetId: string | null;
  shouldAutoBackfill: boolean;
  pollIntervalMs?: number;
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
const DEFAULT_LATENCY: { avgMs: number; p50Ms: number; p95Ms: number } = {
  avgMs: 0,
  p50Ms: 0,
  p95Ms: 0,
};
const DEFAULT_QUEUE_COUNTS: QueueCounts = { queued: 0, running: 0, failed: 0, succeeded: 0 };

export function useVectorQueueState(params: UseVectorQueueStateParams): UseVectorQueueStateResult {
  const { activeEmbeddingSetId, shouldAutoBackfill, pollIntervalMs = 2500 } = params;
  const { metrics } = useEmbeddingQueue();
  const service = params.service;

  const [coverage, setCoverage] = useState<{ total: number; withSet: number }>(DEFAULT_COVERAGE);
  const [queueCounts, setQueueCounts] = useState(DEFAULT_QUEUE_COUNTS);
  const [throughput, setThroughput] = useState(0);
  const [latencyStats, setLatencyStats] = useState(DEFAULT_LATENCY);
  const [lastError, setLastError] = useState<string | null>(null);
  const [recentErrorCount, setRecentErrorCount] = useState(0);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress>(null);
  const [telemetryTrend, setTelemetryTrend] = useState<readonly TelemetryTrendPoint[]>([]);

  const busyRef = useRef(false);
  const autoBackfillRef = useRef<string | null>(null);

  const refreshSnapshot = useCallback(async () => {
    if (!service) return;
    try {
      const snapshot = await service.refresh(activeEmbeddingSetId ?? null);
      if (snapshot.coverage) {
        setCoverage(snapshot.coverage);
      } else if (!activeEmbeddingSetId) {
        setCoverage(DEFAULT_COVERAGE);
      }
      setThroughput(snapshot.throughput);
      setLastError((prev) => snapshot.lastError ?? prev);
      setLatencyStats(snapshot.latency);
      setQueueCounts(snapshot.queueCounts);
      handleQueueStateChange(snapshot.queueCounts, busyRef, activeEmbeddingSetId ?? null);
    } catch {
      // ignore transient refresh errors in the HUD
    }
  }, [service, activeEmbeddingSetId]);

  useEffect(() => {
    if (!service) {
      setCoverage(DEFAULT_COVERAGE);
      setQueueCounts(DEFAULT_QUEUE_COUNTS);
      setThroughput(0);
      setLastError(null);
      setLatencyStats(DEFAULT_LATENCY);
      setRecentErrorCount(0);
      return;
    }

    let canceled = false;
    const tick = async () => {
      if (canceled) return;
      await refreshSnapshot();
    };

    void tick();
    const id = setInterval(tick, pollIntervalMs);
    return () => {
      canceled = true;
      clearInterval(id);
    };
  }, [service, pollIntervalMs, refreshSnapshot]);

  useEffect(() => {
    autoBackfillRef.current = null;
  }, []);

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
    // Note: queueCounts are updated from snapshot.queueCounts in refreshSnapshot
    // We don't update them from metrics because metrics.active doesn't distinguish
    // between queued vs running jobs
    if (metrics.lastError) {
      setLastError(metrics.lastError);
    }
    if (Number.isFinite(metrics.throughputPerMinute)) {
      setThroughput(metrics.throughputPerMinute);
    }
    setLatencyStats({
      avgMs: metrics.latencyAvgMs ?? 0,
      p50Ms: metrics.latencyP50Ms ?? 0,
      p95Ms: metrics.latencyP95Ms ?? 0,
    });
    setRecentErrorCount(metrics.windowErrorCount);
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
      const counts = await service.backfill(activeEmbeddingSetId, (done, total) => {
        setBackfillProgress({ done, total });
      });
      setQueueCounts(counts);
    } catch {
      // swallow errors; UI will continue polling
    } finally {
      setBackfilling(false);
      setTimeout(() => setBackfillProgress(null), 1000);
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
      } finally {
        await refreshSnapshot();
      }
    },
    [service, refreshSnapshot]
  );

  const clearQueue = useCallback(async () => {
    if (!service) return;
    try {
      await service.clearQueue(['failed']);
    } catch {
      // ignore errors when clearing queue
    } finally {
      await refreshSnapshot();
    }
  }, [service, refreshSnapshot]);

  const wipeQueue = useCallback(async () => {
    if (!service) return;
    try {
      await service.wipeQueue();
    } catch {
      // ignore errors when wiping queue
    } finally {
      await refreshSnapshot();
    }
  }, [service, refreshSnapshot]);

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
