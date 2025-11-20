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

  it('should initialize sink in test environment when enableInTest is true', () => {
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
      adapter: 'pqueue',
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
      flushIntervalMs: 10000,
      useSendBeacon: false,
      enableInTest: true,
    });

    expect(sink).not.toBeNull();

    // Emit 3 events (reaches maxBatchSize)
    for (let index = 0; index < 3; index += 1) {
      emitQueueTelemetry({
        timestamp: Date.now(),
        adapter: 'pqueue',
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
      adapter: 'pqueue',
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
      adapter: 'pqueue',
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
      adapter: 'pqueue',
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
      adapter: 'pqueue',
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
      adapter: 'pqueue',
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
      adapter: 'pqueue',
      event: 'enqueue',
      taskId: 'task-error',
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Queue telemetry sink failed to send payload',
      expect.objectContaining({
        error: 'Network error',
        eventCount: 1,
      })
    );

    await sink?.dispose();
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
      adapter: 'pqueue',
      event: 'enqueue',
      taskId: 'task-500',
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Queue telemetry sink failed to send payload',
      expect.objectContaining({
        error: 'Unexpected response: 500',
      })
    );

    await sink?.dispose();
  });

  it('should flush on dispose', async () => {
    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      flushIntervalMs: 10000, // Long interval
      useSendBeacon: false,
      enableInTest: true,
    });

    expect(sink).not.toBeNull();

    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'pqueue',
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
    fetchSpy.mockImplementation(() => {
      return new Promise((resolve) => {
        resolveFlush = () => {
          resolve({ ok: true, status: 200 });
        };
      });
    });
    beaconSpy.mockReturnValue(false);

    const sink = initializeQueueTelemetrySink({
      endpoint: 'https://example.com/telemetry',
      flushIntervalMs: 1000,
      enableInTest: true,
    });

    // Emit event and start flush
    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'pqueue',
      event: 'enqueue',
      taskId: 'task-1',
    });

    await vi.advanceTimersByTimeAsync(1000);

    // First flush started
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Emit another event and try to flush again
    emitQueueTelemetry({
      timestamp: Date.now(),
      adapter: 'pqueue',
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
      adapter: 'pqueue',
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
      adapter: 'pqueue',
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
      adapter: 'pqueue',
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
      adapter: 'pqueue',
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
      adapter: 'pqueue',
      event: 'enqueue',
      taskId: 'task-timer',
    });

    await sink?.dispose();

    // Advance timers beyond flush interval
    await vi.advanceTimersByTimeAsync(10000);

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
      adapter: 'pqueue',
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
        adapter: 'pqueue',
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
