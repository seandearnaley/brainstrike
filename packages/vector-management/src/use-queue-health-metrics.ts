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
 *   const { metrics, isLoading } = useQueueHealthMetrics();
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

import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import type {
  EphemeralQueueMetrics,
  QueueHealthMetrics,
  WorkerHealthStatus,
} from '@brainstrike/queue';
import { useCallback, useMemo } from 'react';
import { useEmbeddingQueueSafe } from './embedding-queue-provider';

export type UseQueueHealthMetricsOptions = Record<string, never>;

export interface UseQueueHealthMetricsReturn {
  /** Always null — errors are handled by EmbeddingJobQueueTracker. Kept for API compat. */
  readonly error: null;
  /** Always false — metrics are derived reactively from store + context. Kept for API compat. */
  readonly isLoading: false;
  /** Consolidated health metrics */
  readonly metrics: QueueHealthMetrics;
  /**
   * No-op — durable stats update reactively via the shared store, and ephemeral
   * metrics update reactively via context. Kept for API compatibility with
   * QueueDiagnosticsPanel's refresh button.
   */
  readonly refresh: () => Promise<void>;
}

const NOOP_REFRESH = async (): Promise<void> => {};

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
  // BST-359: Read durable stats from shared store (written by EmbeddingJobQueueTracker)
  const durableQueueStats = useVectorStatusUIStore((s) => s.durableQueueStats);

  // Get ephemeral queue metrics from provider (returns null if not within provider)
  const embeddingQueueContext = useEmbeddingQueueSafe();

  const getEphemeralMetrics = useCallback((): EphemeralQueueMetrics | null => {
    if (!embeddingQueueContext) {
      return null;
    }
    return embeddingQueueContext.metrics;
  }, [embeddingQueueContext]);

  const getWorkerHealth = useCallback((): WorkerHealthStatus | null => {
    if (embeddingQueueContext) {
      return {
        error: null,
        isReady: true,
        state: 'ready',
      };
    }
    return null;
  }, [embeddingQueueContext]);

  const metrics: QueueHealthMetrics = useMemo(
    () => ({
      durableQueue: durableQueueStats ?? null,
      ephemeralQueue: getEphemeralMetrics(),
      lastUpdated: Date.now(),
      workerHealth: getWorkerHealth(),
    }),
    [durableQueueStats, getEphemeralMetrics, getWorkerHealth]
  );

  return {
    error: null,
    isLoading: false,
    metrics,
    refresh: NOOP_REFRESH,
  };
}
