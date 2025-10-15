import { describe, expect, it } from 'vitest';
import {
  emitQueueTelemetry,
  initializeQueueTelemetrySink,
  type QueueTelemetryEvent,
} from '@brainstrike/queue';
import { createQueueTelemetryCollector } from '../src';

function createEvent(eventType: QueueTelemetryEvent['event']): QueueTelemetryEvent {
  return {
    timestamp: Date.now(),
    adapter: 'workerpool',
    event: eventType,
    taskId: `task-${Math.random().toString(36).slice(2)}`,
    elapsedMs: eventType === 'complete' ? 42 : undefined,
  };
}

describe('queue telemetry collector', () => {
  it('collects batches emitted through the queue telemetry sink', async () => {
    const collector = createQueueTelemetryCollector({
      apiKey: 'test-key',
      path: '/queue-telemetry',
    });

    await collector.start();
    const endpoint = collector.getEndpoint();
    expect(endpoint).toBeTruthy();

    const sink = initializeQueueTelemetrySink({
      endpoint: endpoint ?? '',
      apiKey: 'test-key',
      enableInTest: true,
      useSendBeacon: false,
      flushIntervalMs: 20,
      maxBatchSize: 10,
    });

    expect(sink).not.toBeNull();

    try {
      emitQueueTelemetry(createEvent('enqueue'));
      emitQueueTelemetry(createEvent('complete'));

      await sink?.flush();

      const batch = await collector.nextBatch({ timeoutMs: 1_000 });
      expect(batch.events).toHaveLength(2);
      expect(batch.runtime).toBe('electron-main');
      expect(batch.metadata).toBeNull();
    } finally {
      await sink?.dispose();
      await collector.stop();
    }
  });
});
