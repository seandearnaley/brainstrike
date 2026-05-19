import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeQueueTelemetrySink } from '../remote-telemetry-sink';
import { emitQueueTelemetry, type QueueTelemetryEvent } from '../telemetry';

// Mock the logger
const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@brainstrike/utils', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

describe('initializeQueueTelemetrySink', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let beaconSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Mock fetch
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal('fetch', fetchSpy);

    // Mock navigator.sendBeacon
    beaconSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', {
      sendBeacon: beaconSpy,
    });

    // Mock window
    vi.stubGlobal('window', {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should return null when endpoint is not provided', () => {
    const sink = initializeQueueTelemetrySink({
      endpoint: '',
    });

    expect(sink).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Queue telemetry sink disabled: endpoint not provided'
    );
  });

  it('should return null in test environment when enableInTest is false', () => {
    vi.stubGlobal('process', {
      env: { NODE_ENV: 'test' },
    });

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      enableInTest: false,
    });

    expect(sink).toBeNull();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Queue telemetry sink disabled in test environment'
    );
  });

  it('should initialize sink in test environment when enableInTest is true', async () => {
    vi.stubGlobal('process', {
      env: { NODE_ENV: 'test' },
    });

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      enableInTest: true,
    });

    expect(sink).not.toBeNull();
    expect(sink?.flush).toBeInstanceOf(Function);
    expect(sink?.dispose).toBeInstanceOf(Function);

    // Dispose the sink to prevent cross-test leakage
    await sink?.dispose();
  });

  it('should return null when fetch is not available and beacon is disabled', () => {
    vi.stubGlobal('fetch', undefined);
    vi.stubGlobal('navigator', undefined);

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      useSendBeacon: false,
      enableInTest: true,
    });

    expect(sink).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Queue telemetry sink disabled: fetch not available'
    );
  });

  it('should collect events and flush after interval', async () => {
    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      flushIntervalMs: 5000,
      useSendBeacon: false,
      enableInTest: true,
    });

    expect(sink).not.toBeNull();

    const event: QueueTelemetryEvent = {
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-1',
    };

    emitQueueTelemetry(event);

    // Wait for flush interval
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await sink?.dispose();
  });

  it('should flush immediately when maxBatchSize is reached', async () => {
    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      maxBatchSize: 3,
      flushIntervalMs: 10_000,
      useSendBeacon: false,
      enableInTest: true,
    });

    expect(sink).not.toBeNull();

    // Emit 3 events (reaches maxBatchSize)
    for (let index = 0; index < 3; index += 1) {
      emitQueueTelemetry({
        timestamp: Date.now(),
        adapter: 'workerpool',
        event: 'enqueue',
        taskId: `task-${index}`,
      });
    }

    // Flush should happen immediately without waiting for interval
    await vi.runAllTimersAsync();

    expect(fetchSpy).toHaveBeenCalled();

    await sink?.dispose();
  });

  it('should use sendBeacon when available', async () => {
    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      flushIntervalMs: 1000,
      enableInTest: true,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-beacon',
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(beaconSpy).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled(); // Should not fall back to fetch

    await sink?.dispose();
  });

  it('should fall back to fetch when sendBeacon fails', async () => {
    beaconSpy.mockReturnValue(false); // Beacon fails

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      flushIntervalMs: 1000,
      enableInTest: true,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-fallback',
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(beaconSpy).toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalled(); // Should fall back to fetch

    await sink?.dispose();
  });

  it('should include API key in headers when provided', async () => {
    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      apiKey: 'test-api-key',
      flushIntervalMs: 1000,
      useSendBeacon: false,
      enableInTest: true,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-api-key',
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/telemetry',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'test-api-key',
        }),
      })
    );

    await sink?.dispose();
  });

  it('should include custom headers when provided', async () => {
    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      headers: {
        'x-custom-header': 'custom-value',
        authorization: 'Bearer token',
      },
      flushIntervalMs: 1000,
      useSendBeacon: false,
      enableInTest: true,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-headers',
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/telemetry',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-custom-header': 'custom-value',
          authorization: 'Bearer token',
        }),
      })
    );

    await sink?.dispose();
  });

  it('should include runtime and metadata in payload', async () => {
    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      runtime: 'electron-renderer',
      metadata: { appVersion: '1.0.0', userId: 'user-123' },
      flushIntervalMs: 1000,
      useSendBeacon: false,
      enableInTest: true,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-metadata',
    });

    await vi.advanceTimersByTimeAsync(1000);

    const callArgs = fetchSpy.mock.calls[0];
    const bodyString = callArgs?.[1]?.body as string;
    const body = JSON.parse(bodyString);

    expect(body.runtime).toBe('electron-renderer');
    expect(body.metadata).toEqual({ appVersion: '1.0.0', userId: 'user-123' });
    expect(body.events).toHaveLength(1);

    await sink?.dispose();
  });

  it('should handle fetch errors and retain events', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'));
    beaconSpy.mockReturnValue(false);

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      flushIntervalMs: 1000,
      enableInTest: true,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-error',
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Queue telemetry sink failed to send payload, will retry',
      expect.objectContaining({
        error: 'Network error',
        eventCount: 1,
        consecutiveFailures: 1,
      })
    );

    await sink?.dispose();
  });

  it('should cap buffered events during endpoint outages and drop oldest events', async () => {
    let callCount = 0;
    fetchSpy.mockImplementation((_endpoint: string, init: RequestInit) => {
      callCount += 1;
      if (callCount <= 2) {
        return Promise.reject(new Error('Network error'));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        body: init.body,
      });
    });
    beaconSpy.mockReturnValue(false);

    const sinkOptions = {
      endpoint: 'https://example.com/telemetry',
      enableInTest: true,
      flushIntervalMs: 60_000,
      maxBatchSize: 10,
      maxBufferedEvents: 3,
      maxConsecutiveFailures: 10,
      retryBaseDelayMs: 0,
      useSendBeacon: false,
    };
    const sink = initializeQueueTelemetrySink(sinkOptions);

    try {
      for (const taskId of ['task-1', 'task-2', 'task-3']) {
        emitQueueTelemetry({
          timestamp: Date.now(),
          adapter: 'workerpool',
          event: 'enqueue',
          taskId,
        });
      }
      await sink?.flush();

      for (const taskId of ['task-4', 'task-5']) {
        emitQueueTelemetry({
          timestamp: Date.now(),
          adapter: 'workerpool',
          event: 'enqueue',
          taskId,
        });
      }
      await sink?.flush();
      await sink?.flush();

      const successBody = JSON.parse(fetchSpy.mock.calls[2]?.[1]?.body as string);
      expect(successBody.events.map((event: QueueTelemetryEvent) => event.taskId)).toEqual([
        'task-3',
        'task-4',
        'task-5',
      ]);
      const dropWarnings = mockLogger.warn.mock.calls.filter(
        ([message]) =>
          message ===
          'Queue telemetry sink dropped buffered events after reaching maxBufferedEvents'
      );
      expect(
        dropWarnings.reduce((total, [, details]) => {
          const droppedEvents =
            typeof details === 'object' && details !== null && 'droppedEvents' in details
              ? details.droppedEvents
              : 0;
          return total + (typeof droppedEvents === 'number' ? droppedEvents : 0);
        }, 0)
      ).toBe(2);
      expect(dropWarnings).toEqual(
        expect.arrayContaining([
          [
            'Queue telemetry sink dropped buffered events after reaching maxBufferedEvents',
            expect.objectContaining({
              bufferedEvents: 4,
              retainedEvents: 3,
              maxBufferedEvents: 3,
            }),
          ],
        ])
      );
    } finally {
      await sink?.dispose();
    }
  });

  it('should back off retries after a failed flush', async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValue({ ok: true, status: 200 });
    beaconSpy.mockReturnValue(false);

    const sinkOptions = {
      endpoint: 'https://example.com/telemetry',
      enableInTest: true,
      flushIntervalMs: 60_000,
      retryBaseDelayMs: 1000,
      useSendBeacon: false,
    };
    const sink = initializeQueueTelemetrySink(sinkOptions);

    try {
      emitQueueTelemetry({
        timestamp: Date.now(),
        adapter: 'workerpool',
        event: 'enqueue',
        taskId: 'task-backoff',
      });

      await sink?.flush();
      await sink?.flush();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      await sink?.flush();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await sink?.flush();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      await sink?.dispose();
    }
  });

  it('should bypass retry backoff when disposing with buffered events', async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValue({ ok: true, status: 200 });
    beaconSpy.mockReturnValue(false);

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      enableInTest: true,
      flushIntervalMs: 60_000,
      retryBaseDelayMs: 10_000,
      useSendBeacon: false,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-dispose-backoff',
    });

    await sink?.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await sink?.dispose();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('should replace a pending interval timer with a shorter retry timer', async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValue({ ok: true, status: 200 });
    beaconSpy.mockReturnValue(false);

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      enableInTest: true,
      flushIntervalMs: 60_000,
      retryBaseDelayMs: 1000,
      useSendBeacon: false,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-shorter-retry',
    });

    await sink?.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await sink?.dispose();
  });

  it('should retain at least one buffered event when maxBufferedEvents is zero', async () => {
    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      enableInTest: true,
      flushIntervalMs: 60_000,
      maxBufferedEvents: 0,
      useSendBeacon: false,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-min-buffer',
    });

    await sink?.dispose();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].taskId).toBe('task-min-buffer');
  });

  describe('Consecutive Failure Disabling', () => {
    it('should disable sink after maxConsecutiveFailures (default 3)', async () => {
      fetchSpy.mockRejectedValue(new Error('Network error'));
      beaconSpy.mockReturnValue(false);

      const sink = initializeQueueTelemetrySink({
        endpoint: 'https://example.com/telemetry',
        flushIntervalMs: 1000,
        enableInTest: true,
        retryBaseDelayMs: 0,
      });

      // First failure - emit event and flush
      emitQueueTelemetry({
        timestamp: Date.now(),
        adapter: 'workerpool',
        event: 'enqueue',
        taskId: 'task-1',
      });
      await sink?.flush();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Queue telemetry sink failed to send payload, will retry',
        expect.objectContaining({ consecutiveFailures: 1 })
      );

      // Second failure - flush again (events were re-queued)
      await sink?.flush();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Queue telemetry sink failed to send payload, will retry',
        expect.objectContaining({ consecutiveFailures: 2 })
      );

      // Third failure - should disable
      await sink?.flush();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Queue telemetry sink disabled after repeated failures - endpoint may be unreachable',
        expect.objectContaining({
          consecutiveFailures: 3,
        })
      );

      await sink?.dispose();
    });

    it('should respect custom maxConsecutiveFailures option', async () => {
      fetchSpy.mockRejectedValue(new Error('Network error'));
      beaconSpy.mockReturnValue(false);

      const sink = initializeQueueTelemetrySink({
        endpoint: 'https://example.com/telemetry',
        flushIntervalMs: 1000,
        maxConsecutiveFailures: 2,
        enableInTest: true,
        retryBaseDelayMs: 0,
      });

      // First failure
      emitQueueTelemetry({
        timestamp: Date.now(),
        adapter: 'workerpool',
        event: 'enqueue',
        taskId: 'task-1',
      });
      await sink?.flush();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Queue telemetry sink failed to send payload, will retry',
        expect.objectContaining({ consecutiveFailures: 1 })
      );

      // Second failure - should disable with maxConsecutiveFailures: 2
      await sink?.flush();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Queue telemetry sink disabled after repeated failures - endpoint may be unreachable',
        expect.objectContaining({
          consecutiveFailures: 2,
        })
      );

      await sink?.dispose();
    });

    it('should drop new events when sink is disabled', async () => {
      fetchSpy.mockRejectedValue(new Error('Network error'));
      beaconSpy.mockReturnValue(false);

      const sink = initializeQueueTelemetrySink({
        endpoint: 'https://example.com/telemetry',
        flushIntervalMs: 1000,
        maxConsecutiveFailures: 1, // Disable after first failure
        enableInTest: true,
      });

      // First event triggers failure and disables sink
      emitQueueTelemetry({
        timestamp: Date.now(),
        adapter: 'workerpool',
        event: 'enqueue',
        taskId: 'task-1',
      });
      await sink?.flush();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Queue telemetry sink disabled after repeated failures - endpoint may be unreachable',
        expect.any(Object)
      );

      vi.clearAllMocks();

      // New events should be dropped (no fetch calls after sink is disabled)
      emitQueueTelemetry({
        timestamp: Date.now(),
        adapter: 'workerpool',
        event: 'enqueue',
        taskId: 'task-2',
      });
      await sink?.flush();

      // Fetch should not be called after sink was disabled
      expect(fetchSpy).not.toHaveBeenCalled();

      await sink?.dispose();
    });

    it('should reset failure counter on successful send', async () => {
      let callCount = 0;
      fetchSpy.mockImplementation(() => {
        callCount += 1;
        // First call fails, second succeeds, third fails
        if (callCount === 1 || callCount === 3) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({ ok: true, status: 200 });
      });
      beaconSpy.mockReturnValue(false);

      const sink = initializeQueueTelemetrySink({
        endpoint: 'https://example.com/telemetry',
        flushIntervalMs: 1000,
        maxConsecutiveFailures: 2,
        enableInTest: true,
        retryBaseDelayMs: 0,
      });

      // First event - will fail
      emitQueueTelemetry({
        timestamp: Date.now(),
        adapter: 'workerpool',
        event: 'enqueue',
        taskId: 'task-1',
      });
      await sink?.flush();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Queue telemetry sink failed to send payload, will retry',
        expect.objectContaining({ consecutiveFailures: 1 })
      );

      // Second attempt - will succeed (events were re-queued from first failure)
      await sink?.flush();

      // Clear mocks to verify next failure starts fresh
      vi.clearAllMocks();

      // Third event - will fail again, but counter should have been reset
      emitQueueTelemetry({
        timestamp: Date.now(),
        adapter: 'workerpool',
        event: 'enqueue',
        taskId: 'task-3',
      });
      await sink?.flush();

      // Should be consecutiveFailures: 1 (reset after success), not 2
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Queue telemetry sink failed to send payload, will retry',
        expect.objectContaining({ consecutiveFailures: 1 })
      );

      await sink?.dispose();
    });

    it('should not attempt flush when disabled', async () => {
      fetchSpy.mockRejectedValue(new Error('Network error'));
      beaconSpy.mockReturnValue(false);

      const sink = initializeQueueTelemetrySink({
        endpoint: 'https://example.com/telemetry',
        flushIntervalMs: 1000,
        maxConsecutiveFailures: 1,
        enableInTest: true,
      });

      // Trigger failure to disable sink
      emitQueueTelemetry({
        timestamp: Date.now(),
        adapter: 'workerpool',
        event: 'enqueue',
        taskId: 'task-1',
      });
      await sink?.flush();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();

      // Manual flush should not attempt to send
      await sink?.flush();

      // No additional calls after sink was disabled
      expect(fetchSpy).not.toHaveBeenCalled();

      await sink?.dispose();
    });
  });

  it('should handle non-ok fetch response', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
    });
    beaconSpy.mockReturnValue(false);

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      flushIntervalMs: 1000,
      enableInTest: true,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-500',
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Queue telemetry sink failed to send payload, will retry',
      expect.objectContaining({
        error: 'Unexpected response: 500',
        consecutiveFailures: 1,
      })
    );

    await sink?.dispose();
  });

  it('should flush on dispose', async () => {
    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      flushIntervalMs: 10_000, // Long interval
      useSendBeacon: false,
      enableInTest: true,
    });

    expect(sink).not.toBeNull();

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-dispose',
    });

    // Should not flush yet (interval not reached)
    expect(fetchSpy).not.toHaveBeenCalled();

    // Dispose should trigger flush
    await sink?.dispose();

    expect(fetchSpy).toHaveBeenCalled();
  });

  it('should not flush when already flushing', async () => {
    let resolveFlush: (() => void) | undefined;
    fetchSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFlush = () => {
            resolve({ ok: true, status: 200 });
          };
        })
    );
    beaconSpy.mockReturnValue(false);

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      flushIntervalMs: 1000,
      enableInTest: true,
    });

    // Emit event and start flush
    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-1',
    });

    await vi.advanceTimersByTimeAsync(1000);

    // First flush started
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Emit another event and try to flush again
    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-2',
    });

    // Manual flush should not happen while already flushing
    await sink?.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1); // Still only 1 call

    // Resolve the first flush
    resolveFlush?.();
    await vi.runAllTimersAsync();

    await sink?.dispose();
  });

  it('should not flush when no events to send', async () => {
    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      enableInTest: true,
    });

    await sink?.flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();

    await sink?.dispose();
  });

  it('should detect browser runtime correctly', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      useSendBeacon: false,
      flushIntervalMs: 1000,
      enableInTest: true,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-runtime',
    });

    vi.advanceTimersByTime(1000);

    const callArgs = fetchSpy.mock.calls[0];
    const bodyString = callArgs?.[1]?.body as string;
    const body = JSON.parse(bodyString);

    expect(body.runtime).toBe('browser');

    sink?.dispose();
  });

  it('should detect electron-renderer runtime correctly', () => {
    vi.stubGlobal('window', { electronAPI: {} });

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      useSendBeacon: false,
      flushIntervalMs: 1000,
      enableInTest: true,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-electron',
    });

    vi.advanceTimersByTime(1000);

    const callArgs = fetchSpy.mock.calls[0];
    const bodyString = callArgs?.[1]?.body as string;
    const body = JSON.parse(bodyString);

    expect(body.runtime).toBe('electron-renderer');

    sink?.dispose();
  });

  it('should detect electron-main runtime correctly', () => {
    vi.stubGlobal('window', undefined);

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      useSendBeacon: false,
      flushIntervalMs: 1000,
      enableInTest: true,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-main',
    });

    vi.advanceTimersByTime(1000);

    const callArgs = fetchSpy.mock.calls[0];
    const bodyString = callArgs?.[1]?.body as string;
    const body = JSON.parse(bodyString);

    expect(body.runtime).toBe('electron-main');

    sink?.dispose();
  });

  it('should use fetch with timeout', async () => {
    vi.useRealTimers(); // Use real timers for this test

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      useSendBeacon: false,
      enableInTest: true,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-timeout',
    });

    await sink?.flush();

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/telemetry',
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
        signal: expect.any(Object),
      })
    );

    await sink?.dispose();
  });

  it('should clear timer on dispose', async () => {
    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      flushIntervalMs: 5000,
      useSendBeacon: false,
      enableInTest: true,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-timer',
    });

    await sink?.dispose();

    // Advance timers beyond flush interval
    await vi.advanceTimersByTimeAsync(10_000);

    // Should only have called flush once (on dispose), not on timer
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('should handle Beacon API throwing error', async () => {
    beaconSpy.mockImplementation(() => {
      throw new Error('Beacon error');
    });

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      flushIntervalMs: 1000,
      enableInTest: true,
    });

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'workerpool',
      event: 'enqueue',
      taskId: 'task-beacon-error',
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to send queue telemetry via Beacon; falling back to fetch',
      expect.objectContaining({
        error: 'Beacon error',
      })
    );

    expect(fetchSpy).toHaveBeenCalled(); // Should fall back to fetch

    await sink?.dispose();
  });

  it('should batch multiple events in single request', async () => {
    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      flushIntervalMs: 1000,
      useSendBeacon: false,
      enableInTest: true,
    });

    // Emit multiple events
    for (let index = 0; index < 5; index += 1) {
      emitQueueTelemetry({
        timestamp: Date.now(),
        adapter: 'workerpool',
        event: 'enqueue',
        taskId: `task-${index}`,
      });
    }

    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const callArgs = fetchSpy.mock.calls[0];
    const bodyString = callArgs?.[1]?.body as string;
    const body = JSON.parse(bodyString);

    expect(body.events).toHaveLength(5);

    await sink?.dispose();
  });
});
