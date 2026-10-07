import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createDarwinManager,
  createEmbeddingHostManager,
  currentLifecycleStatus,
  type EmbeddingLifecycleStatus,
  lifecycleState,
  mockHostWindow,
  powerSaveBlockerIsStartedMock,
  powerSaveBlockerStartMock,
  powerSaveBlockerStopMock,
  type TestableEmbeddingHostManager,
} from './embedding-host-manager-fixture';

describe('EmbeddingHostManager powerSaveBlocker lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    lifecycleState.getHostWindow.mockReturnValue(mockHostWindow);
    currentLifecycleStatus.active = false;
    currentLifecycleStatus.lastError = null;
    currentLifecycleStatus.runtimeId = 'embedding-host-runtime';
    currentLifecycleStatus.runtimeKind = 'embedding-host';
    currentLifecycleStatus.state = 'running';
    lifecycleState.waitForStatus.mockImplementation(async () => {
      const status: EmbeddingLifecycleStatus = {
        active: false,
        lastError: null,
        runtimeId: 'embedding-host-runtime',
        state: 'stopped',
      };
      lifecycleState.setStatus(status);
      return status;
    });
    mockHostWindow.isDestroyed.mockReturnValue(false);
    mockHostWindow.webContents.send.mockReset();
  });

  it('keeps the blocker active across short idle gaps while the host remains running', () => {
    const manager = createDarwinManager();

    manager.syncPowerSaveBlocker({ active: true, lastError: null, state: 'running' });
    manager.syncPowerSaveBlocker({ active: false, lastError: null, state: 'running' });

    vi.advanceTimersByTime(4000);

    manager.syncPowerSaveBlocker({ active: true, lastError: null, state: 'running' });

    expect(powerSaveBlockerStartMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).not.toHaveBeenCalled();
  });

  it('stops the blocker after sustained idle while the host remains running on Darwin', () => {
    const manager = createDarwinManager();

    manager.syncPowerSaveBlocker({ active: true, lastError: null, state: 'running' });
    manager.syncPowerSaveBlocker({ active: false, lastError: null, state: 'running' });

    vi.advanceTimersByTime(5001);

    expect(powerSaveBlockerStartMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).toHaveBeenCalledWith(101);
  });

  it('never invokes the blocker lifecycle for active, idle, or error states off Darwin', () => {
    const manager = createEmbeddingHostManager({
      platform: 'linux',
    }) as unknown as TestableEmbeddingHostManager;

    manager.syncPowerSaveBlocker({ active: true, lastError: null, state: 'running' });
    manager.syncPowerSaveBlocker({ active: false, lastError: null, state: 'running' });
    vi.advanceTimersByTime(5001);
    manager.syncPowerSaveBlocker({ active: false, lastError: 'fatal', state: 'error' });

    expect(powerSaveBlockerStartMock).not.toHaveBeenCalled();
    expect(powerSaveBlockerIsStartedMock).not.toHaveBeenCalled();
    expect(powerSaveBlockerStopMock).not.toHaveBeenCalled();
  });

  it('defaults the blocker policy to the current process platform', () => {
    const defaultManager = createEmbeddingHostManager() as unknown as TestableEmbeddingHostManager;
    defaultManager.syncPowerSaveBlocker({ active: true, lastError: null, state: 'running' });
    const defaultStartCount = powerSaveBlockerStartMock.mock.calls.length;

    powerSaveBlockerStartMock.mockClear();

    const explicitManager = createEmbeddingHostManager({
      platform: process.platform,
    }) as unknown as TestableEmbeddingHostManager;
    explicitManager.syncPowerSaveBlocker({ active: true, lastError: null, state: 'running' });

    expect(powerSaveBlockerStartMock).toHaveBeenCalledTimes(defaultStartCount);
  });

  it('clears a stale id and can start a fresh blocker after stop throws on a dead blocker', async () => {
    const { addLogListener, LogLevel, setLogLevel } = await import('@brainstrike/logging');
    setLogLevel(LogLevel.WARN);
    const warnings: string[] = [];
    const removeLogListener = addLogListener((entry) => {
      if (entry.level === 'warn') {
        warnings.push(entry.message ?? '');
      }
    });

    try {
      powerSaveBlockerStopMock.mockImplementationOnce(() => {
        throw new Error('stop failed');
      });
      // Pre-stop check sees the blocker as started; the post-failure recheck
      // reports it dead — the id is stale, so clearing avoids the wedge.
      powerSaveBlockerIsStartedMock.mockReturnValueOnce(true).mockReturnValueOnce(false);
      const manager = createDarwinManager();

      manager.syncPowerSaveBlocker({ active: true, lastError: null, state: 'running' });
      expect(() =>
        manager.syncPowerSaveBlocker({ active: false, lastError: 'fatal', state: 'error' })
      ).not.toThrow();
      expect(warnings.some((message) => message.includes('powerSaveBlocker stop failed'))).toBe(
        true
      );

      // The failed stop must not wedge the manager: the next active phase
      // must be able to start a brand-new blocker.
      manager.syncPowerSaveBlocker({ active: true, lastError: null, state: 'running' });

      expect(powerSaveBlockerStartMock).toHaveBeenCalledTimes(2);
    } finally {
      removeLogListener();
    }
  });

  it('keeps the id and retries when stop throws but the blocker is still active at the OS', async () => {
    const { addLogListener, LogLevel, setLogLevel } = await import('@brainstrike/logging');
    setLogLevel(LogLevel.WARN);
    const warnings: string[] = [];
    const removeLogListener = addLogListener((entry) => {
      if (entry.level === 'warn') {
        warnings.push(entry.message ?? '');
      }
    });

    try {
      powerSaveBlockerStopMock.mockImplementationOnce(() => {
        throw new Error('stop failed');
      });
      // isStarted stays true throughout: the OS block survived the failed stop.
      // Discarding the id here would leak an unstoppable blocker (machine never
      // sleeps); the manager must keep the handle and retry.
      const manager = createDarwinManager();

      manager.syncPowerSaveBlocker({ active: true, lastError: null, state: 'running' });
      manager.syncPowerSaveBlocker({ active: false, lastError: 'fatal', state: 'error' });
      expect(warnings.some((message) => message.includes('keeping id to retry'))).toBe(true);

      // The kept id means no duplicate blocker can start meanwhile...
      manager.syncPowerSaveBlocker({ active: true, lastError: null, state: 'running' });
      expect(powerSaveBlockerStartMock).toHaveBeenCalledTimes(1);

      // ...and the next stop cycle retries with the SAME id and succeeds.
      manager.syncPowerSaveBlocker({ active: false, lastError: 'fatal', state: 'error' });
      expect(powerSaveBlockerStopMock).toHaveBeenCalledTimes(2);
      expect(powerSaveBlockerStopMock).toHaveBeenLastCalledWith(101);

      // After the successful retry the id is cleared and a fresh start works.
      manager.syncPowerSaveBlocker({ active: true, lastError: null, state: 'running' });
      expect(powerSaveBlockerStartMock).toHaveBeenCalledTimes(2);
    } finally {
      removeLogListener();
    }
  });

  it('stops the blocker immediately when the host leaves the running state', () => {
    const manager = createDarwinManager();

    manager.syncPowerSaveBlocker({ active: true, lastError: null, state: 'running' });
    manager.syncPowerSaveBlocker({ active: false, lastError: 'fatal', state: 'error' });

    expect(powerSaveBlockerStartMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).toHaveBeenCalledWith(101);
  });

  it('does not stop the blocker from an idle timer after the manager is disposed', () => {
    const manager = createDarwinManager() as TestableEmbeddingHostManager & {
      disposed: boolean;
    };

    manager.syncPowerSaveBlocker({ active: true, lastError: null, state: 'running' });
    manager.syncPowerSaveBlocker({ active: false, lastError: null, state: 'running' });
    manager.disposed = true;

    vi.advanceTimersByTime(5001);

    expect(powerSaveBlockerStopMock).not.toHaveBeenCalled();
  });

  it('fails fast if ensureStarted is called after dispose', async () => {
    const manager = createEmbeddingHostManager();

    await manager.dispose();

    await expect(manager.ensureStarted()).rejects.toThrow(
      'EmbeddingHostManager.ensureStarted cannot be called after dispose().'
    );
  });

  it('exposes platform status with pending query count and disposed state', async () => {
    const manager = createEmbeddingHostManager();

    expect(manager.getPlatformStatus()).toMatchObject({
      pendingRequestCount: 0,
      runtimeId: 'embedding-host-runtime',
      runtimeKind: 'embedding-host',
      sourceState: 'running',
      state: 'idle',
    });

    await manager.dispose();

    expect(manager.getPlatformStatus()).toMatchObject({
      runtimeKind: 'embedding-host',
      sourceState: 'stopped',
      state: 'disposed',
    });
  });

  it.each([false, true])('drains startup if registered: %s', async (registered) => {
    currentLifecycleStatus.state = 'starting';
    const manager = createEmbeddingHostManager();
    if (registered) {
      manager.acceptStatusReport(mockHostWindow.webContents.id, {
        ...currentLifecycleStatus,
        runtimeKind: 'embedding-host',
      });
    }
    await manager.dispose();
    expect(mockHostWindow.webContents.send).toHaveBeenCalledTimes(registered ? 1 : 0);
    expect(lifecycleState.waitForStatus).toHaveBeenCalledTimes(registered ? 1 : 0);
    expect(lifecycleState.dispose).toHaveBeenCalledOnce();
    expect(lifecycleState.destroyHostWindow).toHaveBeenCalled();
  });

  it('captures the runtime id and exposes renderer stop failure after teardown', async () => {
    const status = {
      ...currentLifecycleStatus,
      lastError: 'Renderer could not stop its worker',
      state: 'error' as const,
    };
    lifecycleState.waitForStatus.mockResolvedValueOnce(status);
    const manager = createEmbeddingHostManager();

    await expect(manager.stop()).rejects.toThrow('Renderer could not stop its worker');

    const sent = mockHostWindow.webContents.send.mock.calls.at(-1)?.[1] as { requestId: string };
    const predicate = lifecycleState.waitForStatus.mock.calls[0]?.[0];
    expect(predicate?.(status)).toBe(false);
    expect(predicate?.({ ...status, commandId: 'different-command' })).toBe(false);
    expect(predicate?.({ ...status, commandId: sent.requestId })).toBe(true);
    expect(predicate?.({ ...status, commandId: sent.requestId, state: 'stopped' })).toBe(true);

    expect(mockHostWindow.webContents.send).toHaveBeenCalledWith(
      'embedding-host:command',
      expect.objectContaining({
        runtimeId: 'embedding-host-runtime',
      })
    );
    expect(lifecycleState.waitForStatus).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      10_000
    );
    expect(lifecycleState.destroyHostWindow).toHaveBeenCalledTimes(1);
    expect(lifecycleState.clearHostWindow).toHaveBeenCalledTimes(1);
    expect(lifecycleState.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeId: 'embedding-host-runtime', state: 'stopped' })
    );
  });

  it('reset returns to running without destroying the host window when the renderer restarts cleanly', async () => {
    lifecycleState.waitForStatus.mockResolvedValueOnce({
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:next-runtime',
      state: 'running',
    });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      'next-runtime' as unknown as ReturnType<Crypto['randomUUID']>
    );
    const manager = createEmbeddingHostManager();

    await expect(manager.reset()).resolves.toMatchObject({
      runtimeId: 'embedding-host:next-runtime',
      state: 'running',
    });

    expect(mockHostWindow.webContents.send).toHaveBeenCalledWith(
      'embedding-host:command',
      expect.objectContaining({
        payload: { action: 'reset', nextRuntimeId: 'embedding-host:next-runtime' },
        runtimeId: 'embedding-host-runtime',
      })
    );
    expect(lifecycleState.destroyHostWindow).not.toHaveBeenCalled();
  });

  it('exposes resetting platform status while a renderer reset is in flight', async () => {
    let resolveReset!: () => void;
    const resetStatus: {
      active: boolean;
      lastError: null;
      runtimeId: string;
      state: 'running';
    } = {
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:next-runtime',
      state: 'running',
    };
    lifecycleState.waitForStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReset = () => {
          lifecycleState.setStatus(resetStatus);
          resolve(resetStatus);
        };
      })
    );
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      'next-runtime' as unknown as ReturnType<Crypto['randomUUID']>
    );
    const manager = createEmbeddingHostManager();

    const resetPromise = manager.reset();

    expect(manager.getPlatformStatus()).toMatchObject({
      runtimeKind: 'embedding-host',
      sourceState: 'starting',
      state: 'resetting',
    });

    resolveReset();
    await expect(resetPromise).resolves.toMatchObject({
      runtimeId: 'embedding-host:next-runtime',
      state: 'running',
    });
    expect(manager.getPlatformStatus()).toMatchObject({
      state: 'idle',
    });
  });

  it('exposes restarting platform status while a host process restart is in flight', async () => {
    let resolveRestart!: () => void;
    const restartStatus: {
      active: boolean;
      lastError: null;
      runtimeId: string;
      state: 'running';
    } = {
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:restarted-runtime',
      state: 'running',
    };
    lifecycleState.ensureStarted.mockReturnValueOnce(
      new Promise((resolve) => {
        lifecycleState.setStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:restarted-runtime',
          state: 'starting',
        });
        resolveRestart = () => {
          lifecycleState.setStatus(restartStatus);
          resolve(restartStatus);
        };
      })
    );
    const manager = createEmbeddingHostManager();

    const restartPromise = manager.destroyAndRestart();

    expect(manager.getPlatformStatus()).toMatchObject({
      runtimeKind: 'embedding-host',
      sourceState: 'starting',
      state: 'restarting',
    });
    expect(lifecycleState.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'stopped' })
    );

    resolveRestart();
    await expect(restartPromise).resolves.toMatchObject({
      runtimeId: 'embedding-host:restarted-runtime',
      state: 'running',
    });
    expect(manager.getPlatformStatus()).toMatchObject({
      state: 'idle',
    });
  });

  it('reset waits for the freshly assigned runtime id before resolving', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      'next-runtime' as unknown as ReturnType<Crypto['randomUUID']>
    );
    lifecycleState.waitForStatus.mockImplementationOnce(async (predicate) => {
      expect(
        predicate({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host-runtime',
          state: 'running',
        })
      ).toBe(false);
      expect(
        predicate({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:next-runtime',
          state: 'running',
        })
      ).toBe(true);
      return {
        active: false,
        lastError: null,
        runtimeId: 'embedding-host:next-runtime',
        state: 'running' as const,
      };
    });

    const manager = createEmbeddingHostManager();

    await expect(manager.reset()).resolves.toMatchObject({
      runtimeId: 'embedding-host:next-runtime',
      state: 'running',
    });
  });

  it('ignores stale status reports from the superseded runtime after reset assigns a fresh runtime id', () => {
    const manager = createEmbeddingHostManager();

    lifecycleState.setStatus({
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:next-runtime',
      state: 'starting',
    });

    manager.acceptStatusReport(91, {
      active: false,
      lastError: null,
      runtimeId: 'embedding-host-runtime',
      runtimeKind: 'embedding-host',
      state: 'stopped',
    });

    expect(lifecycleState.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: 'embedding-host-runtime',
        state: 'stopped',
      })
    );

    manager.acceptStatusReport(91, {
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:next-runtime',
      runtimeKind: 'embedding-host',
      state: 'running',
    });

    expect(lifecycleState.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runtimeId: 'embedding-host:next-runtime',
        state: 'running',
      })
    );
  });

  it('preserves embedding runtime metadata from status reports', () => {
    const manager = createEmbeddingHostManager();

    manager.acceptStatusReport(91, {
      active: false,
      embeddingRuntime: {
        actualWorkerMetadata: {
          device: 'webgpu',
          dtype: 'fp16',
          fallbackApplied: false,
        },
        backendMismatch: false,
        selectedDevicePreference: 'webgpu',
        telemetry: {
          batchTransfer: { batchCount: 1, lastBytes: 12, peakBytes: 12, totalBytes: 12 },
          cache: {
            entries: [],
            estimatedGpuBytes: 0,
            estimatedHeapBytes: 0,
            memoryEstimateUnavailableCount: 0,
            residentCount: 0,
          },
          health: { failureCount: 0, lastFailure: null },
          lastUpdatedAt: 1000,
          peakVectorsInFlight: 1,
        },
      },
      lastError: null,
      runtimeId: 'embedding-host-runtime',
      runtimeKind: 'embedding-host',
      state: 'running',
    });

    expect(lifecycleState.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        embeddingRuntime: expect.objectContaining({
          actualWorkerMetadata: expect.objectContaining({
            device: 'webgpu',
            dtype: 'fp16',
            fallbackApplied: false,
          }),
          backendMismatch: false,
          selectedDevicePreference: 'webgpu',
          telemetry: expect.objectContaining({
            peakVectorsInFlight: 1,
          }),
        }),
      })
    );
  });

  it('destroyAndRestart recreates the host window and waits for a fresh running status', async () => {
    const manager = createEmbeddingHostManager();

    await expect(manager.destroyAndRestart()).resolves.toMatchObject({
      runtimeId: 'embedding-host-runtime',
      state: 'running',
    });

    expect(lifecycleState.destroyHostWindow).toHaveBeenCalledTimes(1);
    expect(lifecycleState.clearHostWindow).toHaveBeenCalledTimes(1);
    expect(lifecycleState.ensureStarted).toHaveBeenCalledWith({ waitForRunning: true });
  });

  it('rejects pending query embedding requests after joining destruction and restarting the host', async () => {
    const manager = createEmbeddingHostManager();
    const embeddingPromise = manager.queryEmbedding({
      dimensions: 2,
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      query: 'database config',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await expect(manager.destroyAndRestart()).resolves.toMatchObject({
      runtimeId: 'embedding-host-runtime',
      state: 'running',
    });

    await expect(embeddingPromise).rejects.toThrow(
      'Embedding host restarted while inference requests were in flight.'
    );
  });

  it('rejects pending query embedding requests after joining reset of the host runtime', async () => {
    const manager = createEmbeddingHostManager();
    const embeddingPromise = manager.queryEmbedding({
      dimensions: 2,
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      query: 'database config',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await manager.reset();

    await expect(embeddingPromise).rejects.toThrow(
      'Embedding host reset while inference requests were in flight.'
    );
  });

  it('sends local query embedding requests to the embedding host and resolves responses', async () => {
    const manager = createEmbeddingHostManager();

    const embeddingPromise = manager.queryEmbedding({
      dimensions: 2,
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      query: 'where is database config',
    });
    expect(lifecycleState.ensureStarted).toHaveBeenCalledWith({ waitForRunning: true });
    await lifecycleState.ensureStarted.mock.results[0]?.value;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockHostWindow.webContents.send).toHaveBeenCalledWith(
      'embedding-host:query-embedding-request',
      expect.objectContaining({
        channel: 'query-embedding',
        payload: {
          dimensions: 2,
          modelId: 'Xenova/all-MiniLM-L6-v2',
          modelKey: 'local::Xenova/all-MiniLM-L6-v2',
          query: 'where is database config',
        },
        runtimeId: 'embedding-host-runtime',
        type: 'request',
      })
    );

    const request = mockHostWindow.webContents.send.mock.calls[0]?.[1] as {
      requestId: string;
      runtimeId: string;
    };
    manager.acceptQueryEmbeddingResponseReport(91, {
      channel: 'query-embedding-result',
      payload: { embedding: [0.125, 0.75] },
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      type: 'result',
    });

    await expect(embeddingPromise).resolves.toEqual([0.125, 0.75]);
  });

  it('logs a late query embedding response at warn instead of dropping it silently', async () => {
    // No `setLogLevel` here: the level is process-wide with no getter to
    // restore it, and the ambient level already emits warn records. The
    // listener does the filtering, and it is unregistered on test finish so it
    // cannot leak into the rest of the run.
    const { addLogListener } = await import('@brainstrike/logging');
    const warnedRequestIds: unknown[] = [];
    const removeLogListener = addLogListener((entry) => {
      if (entry.level !== 'warn') {
        return;
      }
      for (const arg of entry.args) {
        if (arg && typeof arg === 'object' && 'requestId' in arg) {
          warnedRequestIds.push((arg as { requestId: unknown }).requestId);
        }
      }
    });
    onTestFinished(removeLogListener);
    const manager = createEmbeddingHostManager();
    const embeddingPromise = manager.queryEmbedding({
      dimensions: 2,
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      query: 'database config',
    });
    const observedRejection = embeddingPromise.then(
      () => null,
      (error: unknown) => error
    );
    await lifecycleState.ensureStarted.mock.results[0]?.value;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const request = mockHostWindow.webContents.send.mock.calls[0]?.[1] as {
      requestId: string;
      runtimeId: string;
    };

    await vi.advanceTimersByTimeAsync(60_001);
    await expect(observedRejection).resolves.toBeInstanceOf(Error);
    warnedRequestIds.length = 0;

    manager.acceptQueryEmbeddingResponseReport(91, {
      channel: 'query-embedding-result',
      payload: { embedding: [0.1, 0.2] },
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      type: 'result',
    });
    expect(warnedRequestIds).toContain(`${request.runtimeId}:${request.requestId}`);
  });

  it('preserves the original error cause when sending a query embedding request fails', async () => {
    const sendError = new Error('send failed');
    mockHostWindow.webContents.send.mockImplementation((event: string) => {
      if (event === 'embedding-host:query-embedding-request') {
        throw sendError;
      }
    });
    const manager = createEmbeddingHostManager();

    const embeddingPromise = manager.queryEmbedding({
      dimensions: 2,
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      query: 'database config',
    });
    await lifecycleState.ensureStarted.mock.results[0]?.value;

    await expect(embeddingPromise).rejects.toMatchObject({
      cause: sendError,
      message: expect.stringContaining('could not be sent: send failed'),
    });
  });

  it('rejects query embedding requests when the pending request cap is reached', async () => {
    let nextRequestId = 0;
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
      () =>
        `00000000-0000-4000-8000-${String(++nextRequestId).padStart(12, '0')}` as ReturnType<
          typeof globalThis.crypto.randomUUID
        >
    );
    const manager = createEmbeddingHostManager();
    const payload = {
      dimensions: 2,
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      query: 'database config',
    };

    const pending = Array.from({ length: 8 }, () => manager.queryEmbedding(payload));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await expect(manager.queryEmbedding(payload)).rejects.toThrow(
      'Embedding host has 8 query embedding requests in flight'
    );

    const requests = mockHostWindow.webContents.send.mock.calls.map(
      (call) => call[1] as { requestId: string; runtimeId: string }
    );
    expect(requests).toHaveLength(8);
    for (const request of requests) {
      manager.acceptQueryEmbeddingResponseReport(91, {
        channel: 'query-embedding-result',
        payload: { embedding: [0.25, 0.5] },
        requestId: request.requestId,
        runtimeId: request.runtimeId,
        type: 'result',
      });
    }

    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 8 }, () => [0.25, 0.5])
    );
  });

  it('does not allocate a timeout when the pending query embedding cap is already reached', async () => {
    let nextRequestId = 0;
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
      () =>
        `00000000-0000-4000-8000-${String(++nextRequestId).padStart(12, '0')}` as ReturnType<
          typeof globalThis.crypto.randomUUID
        >
    );
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const manager = createEmbeddingHostManager();
    const payload = {
      dimensions: 2,
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      query: 'database config',
    };

    const pending = Array.from({ length: 8 }, () => manager.queryEmbedding(payload));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const timeoutCallsAfterPendingRequests = setTimeoutSpy.mock.calls.length;

    await expect(manager.queryEmbedding(payload)).rejects.toThrow(
      'Embedding host has 8 query embedding requests in flight'
    );

    expect(setTimeoutSpy.mock.calls).toHaveLength(timeoutCallsAfterPendingRequests);
    const requests = mockHostWindow.webContents.send.mock.calls.map(
      (call) => call[1] as { requestId: string; runtimeId: string }
    );
    for (const request of requests) {
      manager.acceptQueryEmbeddingResponseReport(91, {
        channel: 'query-embedding-result',
        payload: { embedding: [0.25, 0.5] },
        requestId: request.requestId,
        runtimeId: request.runtimeId,
        type: 'result',
      });
    }
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 8 }, () => [0.25, 0.5])
    );
  });

  it('debounces inactive status reports across short embedding idle gaps', () => {
    const manager = createEmbeddingHostManager();

    currentLifecycleStatus.active = true;
    currentLifecycleStatus.state = 'running';

    manager.acceptStatusReport(91, {
      active: false,
      lastError: null,
      runtimeId: 'embedding-host-runtime',
      runtimeKind: 'embedding-host',
      state: 'running',
    });

    vi.advanceTimersByTime(4000);

    manager.acceptStatusReport(91, {
      active: true,
      lastError: null,
      runtimeId: 'embedding-host-runtime',
      runtimeKind: 'embedding-host',
      state: 'running',
    });

    vi.advanceTimersByTime(1500);

    expect(lifecycleState.setStatus).toHaveBeenCalledTimes(1);
    expect(lifecycleState.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        active: true,
        state: 'running',
      })
    );
  });

  it('applies inactive status after sustained embedding idle', () => {
    const manager = createEmbeddingHostManager();

    currentLifecycleStatus.active = true;
    currentLifecycleStatus.state = 'running';

    manager.acceptStatusReport(91, {
      active: false,
      lastError: null,
      runtimeId: 'embedding-host-runtime',
      runtimeKind: 'embedding-host',
      state: 'running',
    });

    vi.advanceTimersByTime(5001);

    expect(lifecycleState.setStatus).toHaveBeenCalledTimes(1);
    expect(lifecycleState.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        active: false,
        state: 'running',
      })
    );
  });
});

describe('EmbeddingHostManager teardown ownership', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    lifecycleState.getHostWindow.mockReturnValue(mockHostWindow);
    currentLifecycleStatus.state = 'running';
    currentLifecycleStatus.runtimeId = 'embedding-host-runtime';
    mockHostWindow.isDestroyed.mockReturnValue(false);
  });

  it('rejects new starts while dispose is still waiting for the renderer stop', async () => {
    const stopped = Promise.withResolvers<EmbeddingLifecycleStatus>();
    lifecycleState.waitForStatus.mockReturnValueOnce(stopped.promise);
    const manager = createEmbeddingHostManager();

    const disposing = manager.dispose();
    await Promise.resolve();
    expect(lifecycleState.waitForStatus).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      3000
    );

    // A backfill arriving mid-teardown must not restart (replace) the host that
    // stop() is waiting on; that orphaned the stop wait for its full timeout.
    await expect(manager.ensureStarted()).rejects.toThrow(
      'EmbeddingHostManager.ensureStarted cannot be called after dispose().'
    );
    expect(lifecycleState.ensureStarted).not.toHaveBeenCalled();

    stopped.resolve({
      active: false,
      lastError: null,
      runtimeId: 'embedding-host-runtime',
      state: 'stopped',
    });
    await disposing;
    expect(lifecycleState.waitForStatus).toHaveBeenCalledOnce();
    expect(lifecycleState.dispose).toHaveBeenCalledOnce();
  });

  it('preserves a failed host stop while still destroying the owned renderer', async () => {
    lifecycleState.getHostWindow.mockReturnValue(mockHostWindow);
    currentLifecycleStatus.state = 'running';
    mockHostWindow.isDestroyed.mockReturnValue(false);
    const failure = new Error('Renderer stop deadline exceeded');
    lifecycleState.waitForStatus.mockRejectedValueOnce(failure);
    const manager = createEmbeddingHostManager();
    await expect(manager.dispose()).rejects.toBe(failure);
    expect(lifecycleState.destroyHostWindow).toHaveBeenCalled();
    expect(lifecycleState.dispose).toHaveBeenCalled();
  });
});
