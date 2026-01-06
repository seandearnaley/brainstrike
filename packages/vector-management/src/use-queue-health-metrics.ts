/**
 * Centralized hook for queue health metrics (BST-166).
 *
 * Consolidates durable (JobQueue) and ephemeral (workerpool) queue metrics
 * into a unified QueueHealthMetrics structure for diagnostics views.
 *
 * @example
 * ```tsx
 * function DiagnosticsPanel() {
 *   const { metrics, isLoading, refresh } = useQueueHealthMetrics();
 *
 *   if (isLoading) return <Skeleton />;
 *
 *   return (
 *     <div>
 *       {metrics.durableQueue && <DurableStats stats={metrics.durableQueue} />}
 *       {metrics.ephemeralQueue && <EphemeralMetrics metrics={metrics.ephemeralQueue} />}
 *     </div>
 *   );
 * }
 * ```
 */

import { JobQueue, usePGliteDatabase } from '@brainstrike/db';
import type {
  DurableQueueStats,
  EphemeralQueueMetrics,
  QueueHealthMetrics,
  WorkerHealthStatus,
} from '@brainstrike/queue';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEmbeddingQueueSafe } from './embedding-queue-provider';

const logger = createLogger('useQueueHealthMetrics');

const EMBEDDING_QUEUE_NAME = 'embeddings';
const DEFAULT_POLL_INTERVAL_MS = 2000;

export type UseQueueHealthMetricsOptions = {
  /** Polling interval in ms (default: 2000) */
  readonly pollIntervalMs?: number;
  /** Whether to enable polling (default: true in browser, false in test) */
  readonly enablePolling?: boolean;
};

export type UseQueueHealthMetricsReturn = {
  /** Consolidated health metrics */
  readonly metrics: QueueHealthMetrics;
  /** Whether initial data is still loading */
  readonly isLoading: boolean;
  /** Force a refresh of all metrics */
  readonly refresh: () => Promise<void>;
  /** Last error encountered, if any */
  readonly error: string | null;
};

/**
 * Initial empty metrics state.
 */
const INITIAL_METRICS: QueueHealthMetrics = {
  durableQueue: null,
  ephemeralQueue: null,
  workerHealth: null,
  lastUpdated: 0,
};

/**
 * Hook to consolidate queue health metrics from multiple sources.
 *
 * Sources:
 * - Durable queue: JobQueue stats from PGlite database
 * - Ephemeral queue: Runtime metrics from EmbeddingQueueProvider
 * - Worker health: Worker state from EmbeddingQueueProvider
 */
export function useQueueHealthMetrics(
  options: UseQueueHealthMetricsOptions = {}
): UseQueueHealthMetricsReturn {
  const { pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = options;

  // Default polling to true in browser, false in test
  const nodeEnv = typeof process !== 'undefined' ? process.env?.['NODE_ENV'] : undefined;
  const defaultEnablePolling = typeof window !== 'undefined' && nodeEnv !== 'test';
  const enablePolling = options.enablePolling ?? defaultEnablePolling;

  const [metrics, setMetrics] = useState<QueueHealthMetrics>(INITIAL_METRICS);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Get database connection
  const db = usePGliteDatabase();
  const jobQueue = useMemo(() => (db ? new JobQueue(db) : null), [db]);

  // Get ephemeral queue metrics from provider (returns null if not within provider)
  const embeddingQueueContext = useEmbeddingQueueSafe();

  // Ref to track if component is mounted
  const mountedRef = useRef(true);

  /**
   * Fetch durable queue stats from database.
   */
  const fetchDurableStats = useCallback(async (): Promise<DurableQueueStats | null> => {
    if (!jobQueue) {
      return null;
    }

    try {
      const stats = await jobQueue.getQueueStats(EMBEDDING_QUEUE_NAME);
      const s = stats?.[0];
      if (!s) {
        return {
          queued: 0,
          running: 0,
          failed: 0,
          succeeded: 0,
          nextRunnableAt: null,
        };
      }
      return {
        queued: s.queued,
        running: s.running,
        failed: s.failed,
        succeeded: s.succeeded,
        nextRunnableAt: s.nextRunnableAt ?? null,
      };
    } catch (err) {
      logger.error('Failed to fetch durable queue stats', { error: err });
      return null;
    }
  }, [jobQueue]);

  /**
   * Get ephemeral queue metrics from context.
   */
  const getEphemeralMetrics = useCallback((): EphemeralQueueMetrics | null => {
    if (!embeddingQueueContext) {
      return null;
    }
    return embeddingQueueContext.metrics;
  }, [embeddingQueueContext]);

  /**
   * Get worker health status.
   * Currently derived from ephemeral queue - can be extended for dedicated worker clients.
   */
  const getWorkerHealth = useCallback((): WorkerHealthStatus | null => {
    // If we have ephemeral metrics, the worker is operational
    if (embeddingQueueContext) {
      return {
        state: 'ready',
        isReady: true,
        error: null,
      };
    }
    return null;
  }, [embeddingQueueContext]);

  /**
   * Refresh all metrics from all sources.
   */
  const refresh = useCallback(async () => {
    try {
      const [durableQueue] = await Promise.all([fetchDurableStats()]);
      const ephemeralQueue = getEphemeralMetrics();
      const workerHealth = getWorkerHealth();

      if (mountedRef.current) {
        setMetrics({
          durableQueue,
          ephemeralQueue,
          workerHealth,
          lastUpdated: Date.now(),
        });
        setIsLoading(false);
        setError(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to refresh queue health metrics', { error: err });
      if (mountedRef.current) {
        setError(message);
        setIsLoading(false);
      }
    }
  }, [fetchDurableStats, getEphemeralMetrics, getWorkerHealth]);

  // Initial fetch and polling setup
  useEffect(() => {
    mountedRef.current = true;
    void refresh();

    if (!enablePolling) {
      return () => {
        mountedRef.current = false;
      };
    }

    const intervalId = setInterval(refresh, pollIntervalMs);
    return () => {
      mountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [refresh, enablePolling, pollIntervalMs]);

  // Update ephemeral metrics reactively when context changes
  useEffect(() => {
    if (!embeddingQueueContext) {
      return;
    }

    setMetrics((prev) => ({
      ...prev,
      ephemeralQueue: embeddingQueueContext.metrics,
      workerHealth: {
        state: 'ready',
        isReady: true,
        error: null,
      },
      lastUpdated: Date.now(),
    }));
  }, [embeddingQueueContext?.metrics]);

  return {
    metrics,
    isLoading,
    refresh,
    error,
  };
}
