export type QueueTelemetryAdapter = 'workerpool' | 'pqueue' | 'custom';

export type QueueTelemetryEventType = 'enqueue' | 'complete' | 'error';

export interface QueueTelemetryEvent {
  readonly timestamp: number;
  readonly adapter: QueueTelemetryAdapter;
  readonly event: QueueTelemetryEventType;
  readonly taskId: string;
  readonly model?: string;
  readonly elapsedMs?: number;
  readonly activeBefore?: number;
  readonly activeAfter?: number;
  readonly pending?: number;
  readonly errorMessage?: string;
  readonly metadata?: Record<string, unknown>;
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
  readonly events: readonly QueueTelemetryEvent[];
  readonly throughputPerMinute: number;
  readonly averageLatencyMs: number | null;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly errorCount: number;
}

function computePercentile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length));
  return sorted[index];
}

export function createQueueTelemetryAggregator(windowMs = 60_000) {
  const events: QueueTelemetryEvent[] = [];

  const prune = (now: number) => {
    const threshold = now - windowMs;
    while (events.length > 0 && events[0]?.timestamp < threshold) {
      events.shift();
    }
  };

  const unsubscribe = addQueueTelemetryListener((event) => {
    events.push(event);
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
