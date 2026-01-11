/**
 * React hook for subscribing to token indexer telemetry (BST-154)
 *
 * Provides real-time telemetry statistics for diagnostics views.
 * Automatically manages aggregator lifecycle and updates on a configurable interval.
 *
 * @example
 * ```tsx
 * function IndexerDiagnosticsPanel() {
 *   const { snapshot } = useIndexerTelemetry({ updateIntervalMs: 1000 });
 *
 *   return (
 *     <div>
 *       <p>Indexed: {snapshot.indexedPerMinute.toFixed(1)}/min</p>
 *       <p>Errors: {snapshot.errorCount}</p>
 *       <p>Cache hit rate: {((snapshot.cacheHitRate ?? 0) * 100).toFixed(1)}%</p>
 *       <p>Avg latency: {snapshot.averageLatencyMs?.toFixed(1) ?? '-'}ms</p>
 *     </div>
 *   );
 * }
 * ```
 */

import { useEffect, useMemo, useState } from 'react';
import { createIndexerTelemetryAggregator, type IndexerTelemetrySnapshot } from './telemetry';

export interface UseIndexerTelemetryOptions {
  /** Time window for aggregation in ms (default: 60000 = 1 minute) */
  windowMs?: number;
  /** Max events to retain (default: 5000) */
  maxEvents?: number;
  /** How often to update the snapshot in ms (default: 1000 = 1 second) */
  updateIntervalMs?: number;
}

export interface UseIndexerTelemetryReturn {
  /** Current telemetry snapshot */
  snapshot: IndexerTelemetrySnapshot;
  /** Reset the aggregator (clears all events) */
  reset: () => void;
}

const emptySnapshot: IndexerTelemetrySnapshot = {
  events: [],
  indexedPerMinute: 0,
  totalFilesPerMinute: 0,
  averageLatencyMs: null,
  latencyP50Ms: null,
  latencyP95Ms: null,
  totalTokensIndexed: 0,
  errorCount: 0,
  cacheHitRate: null,
};

/**
 * React hook for subscribing to token indexer telemetry.
 *
 * Creates an aggregator that collects telemetry events and computes
 * rolling statistics (throughput, latency percentiles, error counts).
 */
export function useIndexerTelemetry({
  windowMs = 60_000,
  maxEvents = 5000,
  updateIntervalMs = 1000,
}: UseIndexerTelemetryOptions = {}): UseIndexerTelemetryReturn {
  const [snapshot, setSnapshot] = useState<IndexerTelemetrySnapshot>(emptySnapshot);
  const [resetCounter, setResetCounter] = useState(0);

  // Create aggregator (recreates when options or reset counter changes)
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetCounter intentionally triggers recreation on reset()
  const aggregator = useMemo(
    () => createIndexerTelemetryAggregator(windowMs, maxEvents),
    [windowMs, maxEvents, resetCounter]
  );

  // Poll for snapshot updates
  useEffect(() => {
    // Initial snapshot
    setSnapshot(aggregator.snapshot());

    // Update on interval
    const intervalId = setInterval(() => {
      setSnapshot(aggregator.snapshot());
    }, updateIntervalMs);

    return () => {
      clearInterval(intervalId);
      aggregator.dispose();
    };
  }, [aggregator, updateIntervalMs]);

  const reset = useMemo(
    () => () => {
      setResetCounter((c) => c + 1);
    },
    []
  );

  return { snapshot, reset };
}
