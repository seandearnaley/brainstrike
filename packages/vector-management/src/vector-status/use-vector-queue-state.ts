import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

export interface UseVectorQueueStateResult {
  coverage: { total: number; withSet: number };
  queueCounts: QueueCounts;
  throughput: number;
  latencyStats: { avgMs: number; p50Ms: number; p95Ms: number };
  lastError: string | null;
  backfilling: boolean;
  backfillProgress: BackfillProgress;
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
  const { service, activeEmbeddingSetId, shouldAutoBackfill, pollIntervalMs = 2500 } = params;

  const [coverage, setCoverage] = useState<{ total: number; withSet: number }>(DEFAULT_COVERAGE);
  const [queueCounts, setQueueCounts] = useState(DEFAULT_QUEUE_COUNTS);
  const [throughput, setThroughput] = useState(0);
  const [latencyStats, setLatencyStats] = useState(DEFAULT_LATENCY);
  const [lastError, setLastError] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress>(null);

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
      setQueueCounts(snapshot.queueCounts);
      setThroughput(snapshot.throughput);
      setLastError(snapshot.lastError);
      setLatencyStats(snapshot.latency);
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
      backfilling,
      backfillProgress,
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
      backfilling,
      backfillProgress,
      backfillActiveSet,
      retryFailed,
      clearQueue,
      wipeQueue,
    ]
  );
}
