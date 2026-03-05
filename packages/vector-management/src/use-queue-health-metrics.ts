/**
 * Centralized hook for queue health metrics (BST-166).
 *
 * Consolidates durable (JobQueue) and ephemeral (workerpool) queue metrics
 * into a unified QueueHealthMetrics structure for diagnostics views.
 *
 * BST-359: Durable stats are now read from the shared Zustand store
 * (written by EmbeddingJobQueueTracker) instead of polling the DB directly.
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

import { useVectorStatusUIStore } from '@brainstrike/preferences';
import type {
  EphemeralQueueMetrics,
  QueueHealthMetrics,
  WorkerHealthStatus,
} from '@brainstrike/queue';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEmbeddingQueueSafe } from './embedding-queue-provider';

export interface UseQueueHealthMetricsOptions {
  /** @deprecated No longer used — durable stats come from the shared store. */
  readonly enablePolling?: boolean;
  /** @deprecated No longer used — durable stats come from the shared store. */
  readonly pollIntervalMs?: number;
}

export interface UseQueueHealthMetricsReturn {
  /** Last error encountered, if any */
  readonly error: string | null;
  /** Whether initial data is still loading */
  readonly isLoading: boolean;
  /** Consolidated health metrics */
  readonly metrics: QueueHealthMetrics;
  /** Force a refresh of ephemeral metrics */
  readonly refresh: () => Promise<void>;
}

/**
 * Hook to consolidate queue health metrics from multiple sources.
 *
 * Sources:
 * - Durable queue: Read from shared Zustand store (written by EmbeddingJobQueueTracker)
 * - Ephemeral queue: Runtime metrics from EmbeddingQueueProvider
 * - Worker health: Worker state from EmbeddingQueueProvider
 */
export function useQueueHealthMetrics(
  _options: UseQueueHealthMetricsOptions = {}
): UseQueueHealthMetricsReturn {
  const [isLoading, setIsLoading] = useState(true);
  const [error] = useState<string | null>(null);

  // BST-359: Read durable stats from shared store (written by EmbeddingJobQueueTracker)
  const durableQueueStats = useVectorStatusUIStore((s) => s.durableQueueStats);

  // Get ephemeral queue metrics from provider (returns null if not within provider)
  const embeddingQueueContext = useEmbeddingQueueSafe();

  const mountedRef = useRef(true);

  const getEphemeralMetrics = useCallback((): EphemeralQueueMetrics | null => {
    if (!embeddingQueueContext) {
      return null;
    }
    return embeddingQueueContext.metrics;
  }, [embeddingQueueContext]);

  const getWorkerHealth = useCallback((): WorkerHealthStatus | null => {
    if (embeddingQueueContext) {
      return {
        state: 'ready',
        isReady: true,
        error: null,
      };
    }
    return null;
  }, [embeddingQueueContext]);

  // Consolidate all sources into a single metrics object
  const metrics: QueueHealthMetrics = useMemo(
    () => ({
      durableQueue: durableQueueStats ?? null,
      ephemeralQueue: getEphemeralMetrics(),
      workerHealth: getWorkerHealth(),
      lastUpdated: Date.now(),
    }),
    [durableQueueStats, getEphemeralMetrics, getWorkerHealth]
  );

  // Mark loading complete after first render
  useEffect(() => {
    mountedRef.current = true;
    setIsLoading(false);
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    // Durable stats are reactively provided by the store.
    // This is kept for API compatibility — ephemeral metrics update reactively too.
  }, []);

  return {
    metrics,
    isLoading,
    refresh,
    error,
  };
}
