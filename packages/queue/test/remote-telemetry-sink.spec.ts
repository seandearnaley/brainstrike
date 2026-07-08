import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitQueueTelemetry, initializeQueueTelemetrySink, type QueueTelemetryEvent } from '../src';

function createEvent(overrides: Partial<QueueTelemetryEvent> = {}): QueueTelemetryEvent {
  return {
    adapter: 'workerpool',
    event: 'enqueue',
    taskId: `task-${Math.random()}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('initializeQueueTelemetrySink', () => {
  const originalFetch = globalThis.fetch;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      // @ts-expect-error - allow removing fetch for cleanup when not originally defined
      globalThis.fetch = undefined;
    }
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('flushes batched telemetry via fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock;

    const sink = initializeQueueTelemetrySink({
      enableInTest: true,
      endpoint: 'https://telemetry.example.com/queue',
      flushIntervalMs: 50,
      maxBatchSize: 50,
      metadata: { test: true },
      useSendBeacon: false,
    });

    expect(sink).not.toBeNull();

    emitQueueTelemetry(createEvent({ event: 'enqueue' }));
    emitQueueTelemetry(createEvent({ elapsedMs: 123, event: 'complete' }));

    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://telemetry.example.com/queue');
    expect(init?.method).toBe('POST');
    expect(init?.headers?.['content-type']).toBe('application/json');
    const payload = JSON.parse(init?.body ?? '{}');
    expect(payload.events).toHaveLength(2);
    expect(payload.metadata).toEqual({ test: true });

    await sink?.dispose();
  });

  it('prefers navigator.sendBeacon when available', async () => {
    const beaconMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { sendBeacon: beaconMock } as unknown as Navigator,
      writable: true,
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const sink = initializeQueueTelemetrySink({
      enableInTest: true,
      endpoint: 'https://telemetry.example.com/queue',
      flushIntervalMs: 10,
    });

    expect(sink).not.toBeNull();

    emitQueueTelemetry(createEvent());

    await vi.runAllTimersAsync();

    expect(beaconMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    await sink?.dispose();
  });

  it('retries sending payload when fetch fails', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock;

    const sink = initializeQueueTelemetrySink({
      enableInTest: true,
      endpoint: 'https://telemetry.example.com/queue',
      flushIntervalMs: 5,
      maxBatchSize: 10,
      retryBaseDelayMs: 0,
      useSendBeacon: false,
    });

    expect(sink).not.toBeNull();

    emitQueueTelemetry(createEvent({ event: 'complete' }));

    await sink?.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await sink?.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await sink?.dispose();
  });
});
