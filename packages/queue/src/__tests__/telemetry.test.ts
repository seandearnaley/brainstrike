import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addQueueTelemetryListener,
  createQueueTelemetryAggregator,
  emitQueueTelemetry,
  type QueueTelemetryEvent,
} from '../telemetry';

describe('emitQueueTelemetry and addQueueTelemetryListener', () => {
  beforeEach(() => {
    // Clear all listeners before each test to avoid interference
    vi.clearAllMocks();
  });

  it('should emit events to registered listeners', () => {
    const listener = vi.fn();
    const unsubscribe = addQueueTelemetryListener(listener);

    const event: QueueTelemetryEvent = {
      adapter: 'workerpool',
      event: 'enqueue',
      model: 'test-model',
      taskId: 'task-123',
      timestamp: Date.now(),
    };

    emitQueueTelemetry(event);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);

    unsubscribe();
  });

  it('should emit to multiple listeners', () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const listener3 = vi.fn();

    const unsubscribe1 = addQueueTelemetryListener(listener1);
    const unsubscribe2 = addQueueTelemetryListener(listener2);
    const unsubscribe3 = addQueueTelemetryListener(listener3);

    const event: QueueTelemetryEvent = {
      adapter: 'workerpool',
      elapsedMs: 1500,
      event: 'complete',
      taskId: 'task-456',
      timestamp: Date.now(),
    };

    emitQueueTelemetry(event);

    expect(listener1).toHaveBeenCalledWith(event);
    expect(listener2).toHaveBeenCalledWith(event);
    expect(listener3).toHaveBeenCalledWith(event);

    unsubscribe1();
    unsubscribe2();
    unsubscribe3();
  });

  it('should not call listener after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = addQueueTelemetryListener(listener);

    const event: QueueTelemetryEvent = {
      adapter: 'workerpool',
      errorMessage: 'Test error',
      event: 'error',
      taskId: 'task-789',
      timestamp: Date.now(),
    };

    emitQueueTelemetry(event);
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();
    unsubscribe();

    emitQueueTelemetry(event);
    expect(listener).not.toHaveBeenCalled();
  });

  it('should handle listener throwing error without breaking other listeners', () => {
    const listener1 = vi.fn(() => {
      throw new Error('Listener 1 error');
    });
    const listener2 = vi.fn();
    const listener3 = vi.fn();

    const unsubscribe1 = addQueueTelemetryListener(listener1);
    const unsubscribe2 = addQueueTelemetryListener(listener2);
    const unsubscribe3 = addQueueTelemetryListener(listener3);

    const event: QueueTelemetryEvent = {
      adapter: 'custom',
      event: 'enqueue',
      taskId: 'task-error',
      timestamp: Date.now(),
    };

    // Should not throw even though listener1 throws
    expect(() => emitQueueTelemetry(event)).not.toThrow();

    // All listeners should have been called
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener3).toHaveBeenCalledTimes(1);

    unsubscribe1();
    unsubscribe2();
    unsubscribe3();
  });

  it('should handle multiple unsubscribe calls', () => {
    const listener = vi.fn();
    const unsubscribe = addQueueTelemetryListener(listener);

    unsubscribe();
    unsubscribe(); // Should not throw

    const event: QueueTelemetryEvent = {
      adapter: 'workerpool',
      event: 'complete',
      taskId: 'task-multi-unsub',
      timestamp: Date.now(),
    };

    emitQueueTelemetry(event);
    expect(listener).not.toHaveBeenCalled();
  });

  it('should handle events with all optional fields', () => {
    const listener = vi.fn();
    const unsubscribe = addQueueTelemetryListener(listener);

    const event: QueueTelemetryEvent = {
      activeAfter: 4,
      activeBefore: 5,
      adapter: 'workerpool',
      elapsedMs: 2500,
      event: 'complete',
      metadata: {
        count: 42,
        custom: 'value',
        nested: { data: true },
      },
      model: 'bert-base',
      pending: 10,
      taskId: 'full-event',
      timestamp: 1_234_567_890,
    };

    emitQueueTelemetry(event);

    expect(listener).toHaveBeenCalledWith(event);
    expect(listener.mock.calls[0]?.[0]).toEqual(event);

    unsubscribe();
  });

  it('should emit when no listeners are registered', () => {
    const event: QueueTelemetryEvent = {
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'no-listeners',
      timestamp: Date.now(),
    };

    // Should not throw
    expect(() => emitQueueTelemetry(event)).not.toThrow();
  });
});

describe('createQueueTelemetryAggregator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create aggregator with default window and maxEvents', () => {
    const aggregator = createQueueTelemetryAggregator();

    const snapshot = aggregator.snapshot();

    expect(snapshot).toEqual({
      averageLatencyMs: null,
      errorCount: 0,
      events: [],
      latencyP50Ms: null,
      latencyP95Ms: null,
      throughputPerMinute: 0,
    });

    aggregator.dispose();
  });

  it('should collect events emitted after creation', () => {
    const aggregator = createQueueTelemetryAggregator();

    const event1: QueueTelemetryEvent = {
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-1',
      timestamp: Date.now(),
    };

    const event2: QueueTelemetryEvent = {
      adapter: 'workerpool',
      elapsedMs: 1000,
      event: 'complete',
      taskId: 'task-1',
      timestamp: Date.now(),
    };

    emitQueueTelemetry(event1);
    emitQueueTelemetry(event2);

    const snapshot = aggregator.snapshot();

    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.events[0]).toEqual(event1);
    expect(snapshot.events[1]).toEqual(event2);

    aggregator.dispose();
  });

  it('should calculate throughput correctly', () => {
    const now = Date.now();
    const aggregator = createQueueTelemetryAggregator(60_000);

    // Emit 10 complete events
    for (let index = 0; index < 10; index += 1) {
      emitQueueTelemetry({
        adapter: 'workerpool',
        elapsedMs: 1000,
        event: 'complete',
        taskId: `task-${index}`,
        timestamp: now,
      });
    }

    const snapshot = aggregator.snapshot(now);

    // 10 completes in 60 seconds = 10 per minute
    expect(snapshot.throughputPerMinute).toBe(10);

    aggregator.dispose();
  });

  it('should calculate average latency correctly', () => {
    const now = Date.now();
    const aggregator = createQueueTelemetryAggregator();

    emitQueueTelemetry({
      adapter: 'workerpool',
      elapsedMs: 1000,
      event: 'complete',
      taskId: 'task-1',
      timestamp: now,
    });

    emitQueueTelemetry({
      adapter: 'workerpool',
      elapsedMs: 2000,
      event: 'complete',
      taskId: 'task-2',
      timestamp: now,
    });

    emitQueueTelemetry({
      adapter: 'workerpool',
      elapsedMs: 3000,
      event: 'complete',
      taskId: 'task-3',
      timestamp: now,
    });

    const snapshot = aggregator.snapshot(now);

    // Average: (1000 + 2000 + 3000) / 3 = 2000
    expect(snapshot.averageLatencyMs).toBe(2000);

    aggregator.dispose();
  });

  it('should calculate P50 latency correctly', () => {
    const now = Date.now();
    const aggregator = createQueueTelemetryAggregator();

    const latencies = [100, 200, 300, 400, 500];
    for (const latency of latencies) {
      emitQueueTelemetry({
        adapter: 'workerpool',
        elapsedMs: latency,
        event: 'complete',
        taskId: `task-${latency}`,
        timestamp: now,
      });
    }

    const snapshot = aggregator.snapshot(now);

    // P50 of [100, 200, 300, 400, 500] = 300
    expect(snapshot.latencyP50Ms).toBe(300);

    aggregator.dispose();
  });

  it('should calculate P95 latency correctly', () => {
    const now = Date.now();
    const aggregator = createQueueTelemetryAggregator();

    const latencies = Array.from({ length: 100 }, (_, index) => (index + 1) * 10);
    for (const latency of latencies) {
      emitQueueTelemetry({
        adapter: 'workerpool',
        elapsedMs: latency,
        event: 'complete',
        taskId: `task-${latency}`,
        timestamp: now,
      });
    }

    const snapshot = aggregator.snapshot(now);

    // P95 calculation: floor(95/100 * 100) = 95, so sorted[95] = 960
    expect(snapshot.latencyP95Ms).toBe(960);

    aggregator.dispose();
  });

  it('should sort completed latencies once per snapshot', () => {
    const now = Date.now();
    const aggregator = createQueueTelemetryAggregator();

    for (const latency of [300, 100, 200]) {
      emitQueueTelemetry({
        adapter: 'workerpool',
        elapsedMs: latency,
        event: 'complete',
        taskId: `task-${latency}`,
        timestamp: now,
      });
    }

    const sortSpy = vi.spyOn(Array.prototype, 'sort');
    try {
      const snapshot = aggregator.snapshot(now);

      expect(snapshot.latencyP50Ms).toBe(200);
      expect(snapshot.latencyP95Ms).toBe(300);
      expect(sortSpy).toHaveBeenCalledTimes(1);
    } finally {
      sortSpy.mockRestore();
      aggregator.dispose();
    }
  });

  it('should count errors correctly', () => {
    const now = Date.now();
    const aggregator = createQueueTelemetryAggregator();

    emitQueueTelemetry({
      adapter: 'workerpool',
      elapsedMs: 1000,
      event: 'complete',
      taskId: 'task-1',
      timestamp: now,
    });

    emitQueueTelemetry({
      adapter: 'workerpool',
      errorMessage: 'Error 1',
      event: 'error',
      taskId: 'task-2',
      timestamp: now,
    });

    emitQueueTelemetry({
      adapter: 'workerpool',
      errorMessage: 'Error 2',
      event: 'error',
      taskId: 'task-3',
      timestamp: now,
    });

    const snapshot = aggregator.snapshot(now);

    expect(snapshot.errorCount).toBe(2);

    aggregator.dispose();
  });

  it('should prune old events based on window', () => {
    const now = Date.now();
    const windowMs = 10_000; // 10 seconds
    const aggregator = createQueueTelemetryAggregator(windowMs);

    // Emit old event first (15 seconds ago, outside window)
    emitQueueTelemetry({
      adapter: 'workerpool',
      elapsedMs: 500,
      event: 'complete',
      taskId: 'task-old',
      timestamp: now - 15_000,
    });

    // Emit event at current time
    emitQueueTelemetry({
      adapter: 'workerpool',
      elapsedMs: 1000,
      event: 'complete',
      taskId: 'task-recent',
      timestamp: now,
    });

    const snapshot = aggregator.snapshot(now);

    // Should only have the recent event (old event was pruned)
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]?.taskId).toBe('task-recent');

    aggregator.dispose();
  });

  it('should enforce maxEvents limit', () => {
    const aggregator = createQueueTelemetryAggregator(60_000, 5);

    // Emit 10 events (more than maxEvents)
    for (let index = 0; index < 10; index += 1) {
      emitQueueTelemetry({
        adapter: 'workerpool',
        event: 'enqueue',
        taskId: `task-${index}`,
        timestamp: Date.now(),
      });
    }

    const snapshot = aggregator.snapshot();

    // Should only have last 5 events
    expect(snapshot.events).toHaveLength(5);
    expect(snapshot.events[0]?.taskId).toBe('task-5');
    expect(snapshot.events[4]?.taskId).toBe('task-9');

    aggregator.dispose();
  });

  it('should handle empty latencies for percentile calculation', () => {
    const aggregator = createQueueTelemetryAggregator();

    emitQueueTelemetry({
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-no-latency',
      timestamp: Date.now(),
    });

    const snapshot = aggregator.snapshot();

    expect(snapshot.latencyP50Ms).toBeNull();
    expect(snapshot.latencyP95Ms).toBeNull();
    expect(snapshot.averageLatencyMs).toBeNull();

    aggregator.dispose();
  });

  it('should ignore negative latencies', () => {
    const now = Date.now();
    const aggregator = createQueueTelemetryAggregator();

    emitQueueTelemetry({
      adapter: 'workerpool',
      elapsedMs: -100, // Negative latency
      event: 'complete',
      taskId: 'task-1',
      timestamp: now,
    });

    emitQueueTelemetry({
      adapter: 'workerpool',
      elapsedMs: 1000,
      event: 'complete',
      taskId: 'task-2',
      timestamp: now,
    });

    const snapshot = aggregator.snapshot(now);

    // Should only consider valid latency
    expect(snapshot.averageLatencyMs).toBe(1000);
    expect(snapshot.latencyP50Ms).toBe(1000);

    aggregator.dispose();
  });

  it('should handle single latency value', () => {
    const now = Date.now();
    const aggregator = createQueueTelemetryAggregator();

    emitQueueTelemetry({
      adapter: 'workerpool',
      elapsedMs: 1500,
      event: 'complete',
      taskId: 'task-single',
      timestamp: now,
    });

    const snapshot = aggregator.snapshot(now);

    expect(snapshot.averageLatencyMs).toBe(1500);
    expect(snapshot.latencyP50Ms).toBe(1500);
    expect(snapshot.latencyP95Ms).toBe(1500);

    aggregator.dispose();
  });

  it('should not collect events after dispose', () => {
    const aggregator = createQueueTelemetryAggregator();

    emitQueueTelemetry({
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-before-dispose',
      timestamp: Date.now(),
    });

    aggregator.dispose();

    emitQueueTelemetry({
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-after-dispose',
      timestamp: Date.now(),
    });

    const snapshot = aggregator.snapshot();

    // Should only have event emitted before dispose
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]?.taskId).toBe('task-before-dispose');
  });

  it('should calculate throughput correctly for custom window', () => {
    const now = Date.now();
    const windowMs = 30_000; // 30 seconds
    const aggregator = createQueueTelemetryAggregator(windowMs);

    // Emit 15 complete events
    for (let index = 0; index < 15; index += 1) {
      emitQueueTelemetry({
        adapter: 'workerpool',
        elapsedMs: 1000,
        event: 'complete',
        taskId: `task-${index}`,
        timestamp: now,
      });
    }

    const snapshot = aggregator.snapshot(now);

    // 15 completes in 30 seconds = 30 per minute
    expect(snapshot.throughputPerMinute).toBe(30);

    aggregator.dispose();
  });

  it('should handle zero window (edge case)', () => {
    const aggregator = createQueueTelemetryAggregator(0);

    emitQueueTelemetry({
      adapter: 'workerpool',
      elapsedMs: 1000,
      event: 'complete',
      taskId: 'task-1',
      timestamp: Date.now(),
    });

    const snapshot = aggregator.snapshot();

    // With zero window, throughput should equal complete count
    expect(snapshot.throughputPerMinute).toBe(1);

    aggregator.dispose();
  });
});
