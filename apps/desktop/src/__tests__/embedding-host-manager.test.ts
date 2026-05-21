import { beforeEach, describe, expect, it, vi } from 'vitest';

const { currentLifecycleStatus, lifecycleState, mockHostWindow } = vi.hoisted(() => {
  const hostWindow = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      id: 91,
      send: vi.fn(),
    },
  };
  const currentStatus = {
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
    runtimeKind: 'embedding-host' as const,
    state: 'running' as const,
  };

  return {
    currentLifecycleStatus: currentStatus,
    lifecycleState: {
      clearHostWindow: vi.fn(),
      destroyHostWindow: vi.fn(),
      dispose: vi.fn(),
      ensureStarted: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-host-runtime',
        state: 'running' as const,
      })),
      getHostWindow: vi.fn(() => hostWindow),
      getStatus: vi.fn(() => ({ ...currentStatus })),
      isHostWindow: vi.fn(() => false),
      setStatus: vi.fn((status) => {
        currentStatus.active = status.active;
        currentStatus.lastError = status.lastError;
        currentStatus.runtimeId = status.runtimeId;
        currentStatus.runtimeKind = status.runtimeKind ?? 'embedding-host';
        currentStatus.state = status.state;
      }),
      waitForStatus: vi.fn(async () => ({
        active: false,
        lastError: 'boom',
        runtimeId: 'embedding-host-runtime',
        state: 'error' as const,
      })),
    },
    mockHostWindow: hostWindow,
  };
});

const { powerSaveBlockerIsStartedMock, powerSaveBlockerStartMock, powerSaveBlockerStopMock } =
  vi.hoisted(() => ({
    powerSaveBlockerStartMock: vi.fn(() => 101),
    powerSaveBlockerStopMock: vi.fn(),
    powerSaveBlockerIsStartedMock: vi.fn(() => true),
  }));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  app: {
    getAppPath: vi.fn(() => '/mock/app'),
    isPackaged: false,
  },
  powerSaveBlocker: {
    start: powerSaveBlockerStartMock,
    stop: powerSaveBlockerStopMock,
    isStarted: powerSaveBlockerIsStartedMock,
  },
}));

vi.mock('../renderer-host-lifecycle', () => ({
  RendererHostLifecycle: vi.fn().mockImplementation(function MockRendererHostLifecycle() {
    return lifecycleState;
  }),
}));

import { EmbeddingHostManager } from '../embedding-host-manager';

type TestableEmbeddingHostManager = EmbeddingHostManager & {
  syncPowerSaveBlocker(status: {
    active: boolean;
    lastError: string | null;
    state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
  }): void;
};

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
    lifecycleState.waitForStatus.mockResolvedValue({
      active: false,
      lastError: 'boom',
      runtimeId: 'embedding-host-runtime',
      state: 'error',
    });
    mockHostWindow.isDestroyed.mockReturnValue(false);
    mockHostWindow.webContents.send.mockReset();
  });

  it('keeps the blocker active across short idle gaps while the host remains running', () => {
    const manager = new EmbeddingHostManager() as TestableEmbeddingHostManager;

    manager.syncPowerSaveBlocker({ state: 'running', active: true, lastError: null });
    manager.syncPowerSaveBlocker({ state: 'running', active: false, lastError: null });

    vi.advanceTimersByTime(4000);

    manager.syncPowerSaveBlocker({ state: 'running', active: true, lastError: null });

    expect(powerSaveBlockerStartMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).not.toHaveBeenCalled();
  });

  it('stops the blocker after sustained idle while the host remains running', () => {
    const manager = new EmbeddingHostManager() as TestableEmbeddingHostManager;

    manager.syncPowerSaveBlocker({ state: 'running', active: true, lastError: null });
    manager.syncPowerSaveBlocker({ state: 'running', active: false, lastError: null });

    vi.advanceTimersByTime(5001);

    expect(powerSaveBlockerStartMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).toHaveBeenCalledWith(101);
  });

  it('stops the blocker immediately when the host leaves the running state', () => {
    const manager = new EmbeddingHostManager() as TestableEmbeddingHostManager;

    manager.syncPowerSaveBlocker({ state: 'running', active: true, lastError: null });
    manager.syncPowerSaveBlocker({ state: 'error', active: false, lastError: 'fatal' });

    expect(powerSaveBlockerStartMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).toHaveBeenCalledTimes(1);
    expect(powerSaveBlockerStopMock).toHaveBeenCalledWith(101);
  });

  it('does not stop the blocker from an idle timer after the manager is disposed', () => {
    const manager = new EmbeddingHostManager() as TestableEmbeddingHostManager & {
      disposed: boolean;
    };

    manager.syncPowerSaveBlocker({ state: 'running', active: true, lastError: null });
    manager.syncPowerSaveBlocker({ state: 'running', active: false, lastError: null });
    manager.disposed = true;

    vi.advanceTimersByTime(5001);

    expect(powerSaveBlockerStopMock).not.toHaveBeenCalled();
  });

  it('fails fast if ensureStarted is called after dispose', async () => {
    const manager = new EmbeddingHostManager();

    await manager.dispose();

    await expect(manager.ensureStarted()).rejects.toThrow(
      'EmbeddingHostManager.ensureStarted cannot be called after dispose().'
    );
  });

  it('exposes platform status with pending query count and disposed state', async () => {
    const manager = new EmbeddingHostManager();

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

  it('captures the runtime id once and tears down on error status during stop', async () => {
    const manager = new EmbeddingHostManager();

    await manager.stop();

    expect(mockHostWindow.webContents.send).toHaveBeenCalledWith(
      'embedding-host:command',
      expect.objectContaining({
        runtimeId: 'embedding-host-runtime',
      })
    );
    expect(lifecycleState.waitForStatus).toHaveBeenCalledWith(expect.any(Function), 10_000);
    expect(lifecycleState.destroyHostWindow).toHaveBeenCalledTimes(1);
    expect(lifecycleState.clearHostWindow).toHaveBeenCalledTimes(1);
    expect(lifecycleState.setStatus).toHaveBeenCalled();
  });

  it('reset returns to running without destroying the host window when the renderer restarts cleanly', async () => {
    lifecycleState.waitForStatus.mockResolvedValueOnce({
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:next-runtime',
      state: 'running',
    });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('next-runtime');
    const manager = new EmbeddingHostManager();

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
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('next-runtime');
    const manager = new EmbeddingHostManager();

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
        resolveRestart = () => {
          lifecycleState.setStatus(restartStatus);
          resolve(restartStatus);
        };
      })
    );
    const manager = new EmbeddingHostManager();

    const restartPromise = manager.destroyAndRestart();

    expect(manager.getPlatformStatus()).toMatchObject({
      runtimeKind: 'embedding-host',
      sourceState: 'stopped',
      state: 'restarting',
    });

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
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('next-runtime');
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

    const manager = new EmbeddingHostManager();

    await expect(manager.reset()).resolves.toMatchObject({
      runtimeId: 'embedding-host:next-runtime',
      state: 'running',
    });
  });

  it('ignores stale status reports from the superseded runtime after reset assigns a fresh runtime id', () => {
    const manager = new EmbeddingHostManager();

    lifecycleState.setStatus({
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:next-runtime',
      state: 'starting',
    });

    manager.acceptStatusReport(91, {
      runtimeKind: 'embedding-host',
      runtimeId: 'embedding-host-runtime',
      state: 'stopped',
      active: false,
      lastError: null,
    });

    expect(lifecycleState.setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: 'embedding-host-runtime',
        state: 'stopped',
      })
    );

    manager.acceptStatusReport(91, {
      runtimeKind: 'embedding-host',
      runtimeId: 'embedding-host:next-runtime',
      state: 'running',
      active: false,
      lastError: null,
    });

    expect(lifecycleState.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runtimeId: 'embedding-host:next-runtime',
        state: 'running',
      })
    );
  });

  it('destroyAndRestart recreates the host window and waits for a fresh running status', async () => {
    const manager = new EmbeddingHostManager();

    await expect(manager.destroyAndRestart()).resolves.toMatchObject({
      runtimeId: 'embedding-host-runtime',
      state: 'running',
    });

    expect(lifecycleState.destroyHostWindow).toHaveBeenCalledTimes(1);
    expect(lifecycleState.clearHostWindow).toHaveBeenCalledTimes(1);
    expect(lifecycleState.ensureStarted).toHaveBeenCalledWith({ waitForRunning: true });
  });

  it('rejects pending query embedding requests before destroying and restarting the host', async () => {
    const manager = new EmbeddingHostManager();
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
      'Embedding host restarted while query embedding requests were in flight.'
    );
  });

  it('rejects pending query embedding requests before resetting the host runtime', async () => {
    const manager = new EmbeddingHostManager();
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
      'Embedding host reset while query embedding requests were in flight.'
    );
  });

  it('sends local query embedding requests to the embedding host and resolves responses', async () => {
    const manager = new EmbeddingHostManager();

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
      type: 'result',
      channel: 'query-embedding-result',
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      payload: { embedding: [0.125, 0.75] },
    });

    await expect(embeddingPromise).resolves.toEqual([0.125, 0.75]);
  });

  it('preserves the original error cause when sending a query embedding request fails', async () => {
    const sendError = new Error('send failed');
    mockHostWindow.webContents.send.mockImplementation(() => {
      throw sendError;
    });
    const manager = new EmbeddingHostManager();

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
    const manager = new EmbeddingHostManager();
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
        type: 'result',
        channel: 'query-embedding-result',
        requestId: request.requestId,
        runtimeId: request.runtimeId,
        payload: { embedding: [0.25, 0.5] },
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
    const manager = new EmbeddingHostManager();
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
        type: 'result',
        channel: 'query-embedding-result',
        requestId: request.requestId,
        runtimeId: request.runtimeId,
        payload: { embedding: [0.25, 0.5] },
      });
    }
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: 8 }, () => [0.25, 0.5])
    );
  });

  it('debounces inactive status reports across short embedding idle gaps', () => {
    const manager = new EmbeddingHostManager();

    currentLifecycleStatus.active = true;
    currentLifecycleStatus.state = 'running';

    manager.acceptStatusReport(91, {
      runtimeKind: 'embedding-host',
      runtimeId: 'embedding-host-runtime',
      state: 'running',
      active: false,
      lastError: null,
    });

    vi.advanceTimersByTime(4000);

    manager.acceptStatusReport(91, {
      runtimeKind: 'embedding-host',
      runtimeId: 'embedding-host-runtime',
      state: 'running',
      active: true,
      lastError: null,
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
    const manager = new EmbeddingHostManager();

    currentLifecycleStatus.active = true;
    currentLifecycleStatus.state = 'running';

    manager.acceptStatusReport(91, {
      runtimeKind: 'embedding-host',
      runtimeId: 'embedding-host-runtime',
      state: 'running',
      active: false,
      lastError: null,
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
