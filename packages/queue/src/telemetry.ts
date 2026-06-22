/**
 * Queue adapter identifier for telemetry.
 *
 * - 'job-queue': Durable DB-backed JobQueue (SQL persistence)
 * - 'workerpool': Ephemeral in-memory workerpool (browser compute)
 * - 'custom': Custom/third-party queue implementations
 */
export type QueueTelemetryAdapter = 'job-queue' | 'workerpool' | 'custom';

/**
 * Telemetry event types for queue operations.
 *
 * - 'enqueue': Task added to queue
 * - 'start': Task claimed/started processing (for job-queue: claim; for workerpool: exec start)
 * - 'complete': Task finished successfully
 * - 'error': Task failed (may be retriable or terminal)
 * - 'cancel': Task was canceled before completion
 */
export type QueueTelemetryEventType = 'enqueue' | 'start' | 'complete' | 'error' | 'cancel';

export interface QueueTelemetryEvent {
  readonly activeAfter?: number;
  readonly activeBefore?: number;
  readonly adapter: QueueTelemetryAdapter;
  readonly elapsedMs?: number;
  readonly errorMessage?: string;
  readonly event: QueueTelemetryEventType;
  readonly metadata?: Record<string, unknown>;
  readonly model?: string;
  readonly pending?: number;
  readonly taskId: string;
  readonly timestamp: number;
}

export type QueueTelemetryListener = (event: QueueTelemetryEvent) => void;

const telemetryListeners = new Set<QueueTelemetryListener>();

export function emitQueueTelemetry(event: QueueTelemetryEvent): void {
  telemetryListeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // Listeners must not break telemetry dispatching.
    }
  });
}

export function addQueueTelemetryListener(listener: QueueTelemetryListener): () => void {
  telemetryListeners.add(listener);
  return () => {
    telemetryListeners.delete(listener);
  };
}

export interface QueueTelemetrySnapshot {
  readonly averageLatencyMs: number | null;
  readonly errorCount: number;
  readonly events: readonly QueueTelemetryEvent[];
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly throughputPerMinute: number;
}

function computePercentile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length));
  return sorted[index] ?? null;
}

export function createQueueTelemetryAggregator(windowMs = 60_000, maxEvents = 5000) {
  const events: QueueTelemetryEvent[] = [];

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

  const unsubscribe = addQueueTelemetryListener((event) => {
    events.push(event);
    if (events.length > maxEvents) {
      events.splice(0, events.length - maxEvents);
    }
    prune(event.timestamp);
  });

  const snapshot = (now = Date.now()): QueueTelemetrySnapshot => {
    prune(now);
    const windowEvents = events.slice();
    const completes = windowEvents.filter((event) => event.event === 'complete');
    const throughputPerMinute =
      windowMs === 0 ? completes.length : (completes.length * 60_000) / windowMs;
    const latencies = completes
      .map((event) => event.elapsedMs)
      .filter((value): value is number => typeof value === 'number' && value >= 0);
    const averageLatency =
      latencies.length > 0
        ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
        : null;
    const latencyP50 = computePercentile(latencies, 50);
    const latencyP95 = computePercentile(latencies, 95);
    const errorCount = windowEvents.filter((event) => event.event === 'error').length;

    return {
      events: windowEvents,
      throughputPerMinute,
      averageLatencyMs: averageLatency,
      latencyP50Ms: latencyP50,
      latencyP95Ms: latencyP95,
      errorCount,
    };
  };

  return {
    snapshot,
    dispose: unsubscribe,
  };
}
