/**
 * Token Indexer Telemetry
 *
 * Pub/sub telemetry for token indexing operations.
 * Follows the same pattern as @brainstrike/queue telemetry.
 *
 * Event types:
 * - indexed_file: File successfully indexed (includes cache hits)
 * - indexing_error: File failed to index
 * - indexing_backlog: Periodic queue depth snapshot
 *
 * @see packages/queue/src/telemetry.ts for the queue telemetry pattern
 */

import type { TokenCountingMode } from './types';

/**
 * Telemetry event types for token indexing
 */
export type IndexerTelemetryEventType = 'indexed_file' | 'indexing_error' | 'indexing_backlog';

/**
 * Base fields shared by all indexer telemetry events
 */
interface IndexerTelemetryEventBase {
  readonly timestamp: number;
  readonly event: IndexerTelemetryEventType;
}

/**
 * Emitted when a file is successfully indexed (or cache-hit skipped)
 */
export type IndexedFileTelemetryEvent = IndexerTelemetryEventBase & {
  readonly event: 'indexed_file';
  readonly compositeKey: string;
  readonly folderId: string;
  readonly filePath: string;
  readonly tokenCount: number;
  readonly mode: TokenCountingMode;
  readonly fileSize: number;
  /** Time taken to index this file (ms) */
  readonly elapsedMs: number;
  /** True if this was a cache hit (hash matched, counting skipped) */
  readonly skipped: boolean;
};

/**
 * Emitted when indexing a file fails
 */
export type IndexingErrorTelemetryEvent = IndexerTelemetryEventBase & {
  readonly event: 'indexing_error';
  readonly compositeKey: string;
  readonly folderId?: string;
  readonly filePath?: string;
  readonly errorMessage: string;
};

/**
 * Emitted periodically to report queue depth
 */
export type IndexingBacklogTelemetryEvent = IndexerTelemetryEventBase & {
  readonly event: 'indexing_backlog';
  /** Files currently being processed */
  readonly inFlight: number;
  /** Total files in the current batch */
  readonly batchTotal: number;
  /** Files completed in the current batch */
  readonly batchCompleted: number;
};

/**
 * Union of all indexer telemetry event types
 */
export type IndexerTelemetryEvent =
  | IndexedFileTelemetryEvent
  | IndexingErrorTelemetryEvent
  | IndexingBacklogTelemetryEvent;

export type IndexerTelemetryListener = (event: IndexerTelemetryEvent) => void;

const telemetryListeners = new Set<IndexerTelemetryListener>();

/**
 * Emit an indexer telemetry event to all registered listeners.
 * Listener errors are silently caught to prevent breaking dispatch.
 */
export function emitIndexerTelemetry(event: IndexerTelemetryEvent): void {
  for (const listener of telemetryListeners) {
    try {
      listener(event);
    } catch {
      // Listeners must not break telemetry dispatching.
    }
  }
}

/**
 * Register a listener for indexer telemetry events.
 * @returns Unsubscribe function
 */
export function addIndexerTelemetryListener(listener: IndexerTelemetryListener): () => void {
  telemetryListeners.add(listener);
  return () => {
    telemetryListeners.delete(listener);
  };
}

/**
 * Aggregated snapshot of indexer telemetry within a time window
 */
export interface IndexerTelemetrySnapshot {
  readonly events: readonly IndexerTelemetryEvent[];
  /** Files indexed per minute (excludes cache hits) */
  readonly indexedPerMinute: number;
  /** Files indexed per minute (includes cache hits) */
  readonly totalFilesPerMinute: number;
  /** Average indexing time (ms), excludes cache hits */
  readonly averageLatencyMs: number | null;
  /** 50th percentile latency (ms) */
  readonly latencyP50Ms: number | null;
  /** 95th percentile latency (ms) */
  readonly latencyP95Ms: number | null;
  /** Total tokens indexed in window */
  readonly totalTokensIndexed: number;
  /** Number of indexing errors in window */
  readonly errorCount: number;
  /** Cache hit rate (0-1) */
  readonly cacheHitRate: number | null;
}

function computePercentile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length));
  return sorted[index] ?? null;
}

/**
 * Create an aggregator that collects indexer telemetry events and computes statistics.
 *
 * @param windowMs - Time window for aggregation (default: 60 seconds, 0 = no time-based pruning)
 * @param maxEvents - Maximum events to retain (default: 5000)
 * @returns Object with snapshot() method and dispose() cleanup
 */
export function createIndexerTelemetryAggregator(windowMs = 60_000, maxEvents = 5000) {
  const events: IndexerTelemetryEvent[] = [];

  const prune = (now: number) => {
    if (windowMs === 0) {
      return; // Zero window means no time-based pruning
    }
    const threshold = now - windowMs;
    while (events.length > 0) {
      const [oldest] = events;
      if (oldest === undefined || oldest.timestamp >= threshold) {
        break;
      }
      events.shift();
    }
  };

  const unsubscribe = addIndexerTelemetryListener((event) => {
    events.push(event);
    if (events.length > maxEvents) {
      events.splice(0, events.length - maxEvents);
    }
    prune(event.timestamp);
  });

  const snapshot = (now = Date.now()): IndexerTelemetrySnapshot => {
    prune(now);
    const windowEvents = events.slice();

    // Filter indexed_file events
    const indexedFiles = windowEvents.filter(
      (e): e is IndexedFileTelemetryEvent => e.event === 'indexed_file'
    );

    // Separate cache hits from actual indexing
    const actuallyIndexed = indexedFiles.filter((e) => !e.skipped);
    const cacheHits = indexedFiles.filter((e) => e.skipped);

    // Throughput calculations
    const indexedPerMinute =
      windowMs === 0 ? actuallyIndexed.length : (actuallyIndexed.length * 60_000) / windowMs;
    const totalFilesPerMinute =
      windowMs === 0 ? indexedFiles.length : (indexedFiles.length * 60_000) / windowMs;

    // Latency calculations (only for actually indexed files)
    const latencies = actuallyIndexed.map((e) => e.elapsedMs).filter((ms) => ms >= 0);
    const averageLatency =
      latencies.length > 0 ? latencies.reduce((sum, v) => sum + v, 0) / latencies.length : null;
    const latencyP50 = computePercentile(latencies, 50);
    const latencyP95 = computePercentile(latencies, 95);

    // Token count (from actually indexed files only - cache hits don't report accurate counts)
    const totalTokensIndexed = actuallyIndexed.reduce((sum, e) => sum + e.tokenCount, 0);

    // Error count
    const errorCount = windowEvents.filter((e) => e.event === 'indexing_error').length;

    // Cache hit rate
    const cacheHitRate = indexedFiles.length > 0 ? cacheHits.length / indexedFiles.length : null;

    return {
      events: windowEvents,
      indexedPerMinute,
      totalFilesPerMinute,
      averageLatencyMs: averageLatency,
      latencyP50Ms: latencyP50,
      latencyP95Ms: latencyP95,
      totalTokensIndexed,
      errorCount,
      cacheHitRate,
    };
  };

  return {
    snapshot,
    dispose: unsubscribe,
  };
}

// --- Helper functions for emitting common events ---

/**
 * Emit an indexed_file telemetry event
 */
export function emitIndexedFile(params: {
  compositeKey: string;
  folderId: string;
  filePath: string;
  tokenCount: number;
  mode: TokenCountingMode;
  fileSize: number;
  elapsedMs: number;
  skipped: boolean;
}): void {
  emitIndexerTelemetry({
    timestamp: Date.now(),
    event: 'indexed_file',
    ...params,
  });
}

/**
 * Emit an indexing_error telemetry event
 */
export function emitIndexingError(params: {
  compositeKey: string;
  folderId?: string;
  filePath?: string;
  errorMessage: string;
}): void {
  emitIndexerTelemetry({
    timestamp: Date.now(),
    event: 'indexing_error',
    ...params,
  });
}

/**
 * Emit an indexing_backlog telemetry event
 */
export function emitIndexingBacklog(params: {
  inFlight: number;
  batchTotal: number;
  batchCompleted: number;
}): void {
  emitIndexerTelemetry({
    timestamp: Date.now(),
    event: 'indexing_backlog',
    ...params,
  });
}
