import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAllWindowsMock, lifecycleState, mockHostWindow } = vi.hoisted(() => {
  const hostWindow = {
    id: 71,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    webContents: {
      id: 71,
      send: vi.fn(),
    },
  };

  return {
    getAllWindowsMock: vi.fn<() => unknown[]>(() => []),
    lifecycleState: {
      acceptsStatus: vi.fn(() => true),
      destroyHostWindow: vi.fn(),
      dispose: vi.fn(),
      ensureStarted: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'chunking-host-runtime',
        state: 'running' as const,
      })),
      getHostWindow: vi.fn<() => typeof hostWindow | null | undefined>(() => hostWindow),
      getStatus: vi.fn(() => ({
        active: false,
        lastError: null,
        runtimeId: 'chunking-host-runtime',
        state: 'running' as const,
      })),
      isHostWindow: vi.fn(() => false),
      joinPhysicalClose: vi.fn(async () => {}),
      restart: vi.fn(async function (this: { ensureStarted(): Promise<unknown> }) {
        return this.ensureStarted();
      }),
      retire: vi.fn(async function (this: { destroyHostWindow(): Promise<void> }) {
        await this.destroyHostWindow();
      }),
      setStatus: vi.fn(),
      stop: vi.fn(async function (
        this: { destroyHostWindow(): Promise<void> },
        protocol?: () => Promise<void>
      ) {
        const failures: unknown[] = [];
        try {
          await protocol?.();
        } catch (cause) {
          failures.push(cause);
        }
        try {
          await this.destroyHostWindow();
        } catch (cause) {
          failures.push(cause);
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Stop and physical release failed');
        }
      }),
      waitForStatus: vi.fn(),
    },
    mockHostWindow: hostWindow,
  };
});

const loggerWarnMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: loggerWarnMock,
    }),
  };
});

vi.mock('../renderer-host-lifecycle', () => ({
  RendererHostLifecycle: vi.fn().mockImplementation(function MockRendererHostLifecycle() {
    return lifecycleState;
  }),
}));

import { ChunkingHostManager } from '../chunking-host-manager';

// Omit<T, never> is NOT a no-op: it maps over the class's public keys and
// yields a plain object type without private members, which is what lets the
// intersection below redeclare internals as test-visible seams.
type TestableChunkingHostManager = Omit<ChunkingHostManager, never> & {
  acceptResponseReport: (
    senderId: number,
    report: {
      channel: string;
      payload: Record<string, unknown>;
      requestId: string;
      runtimeId: string;
      type: string;
    }
  ) => void;
  requests: { has: (requestId: string) => boolean; size: () => number };
};

describe('ChunkingHostManager', () => {
  it('retains independent stop and lifecycle disposal failures', async () => {
    const manager = new ChunkingHostManager();
    const stopFailure = new Error('Stop acknowledgement lost');
    const releaseFailure = new Error('Physical release failed');
    lifecycleState.stop.mockRejectedValueOnce(stopFailure);
    lifecycleState.dispose.mockRejectedValueOnce(releaseFailure);
    const outcome = await manager.dispose().catch((cause: unknown) => cause);
    expect(outcome).toBeInstanceOf(AggregateError);
    expect((outcome as AggregateError).errors).toEqual([stopFailure, releaseFailure]);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    getAllWindowsMock.mockReturnValue([]);
    lifecycleState.ensureStarted.mockResolvedValue({
      active: false,
      lastError: null,
      runtimeId: 'chunking-host-runtime',
      state: 'running',
    });
    lifecycleState.getHostWindow.mockReturnValue(mockHostWindow);
    lifecycleState.getStatus.mockReturnValue({
      active: false,
      lastError: null,
      runtimeId: 'chunking-host-runtime',
      state: 'running',
    });
    mockHostWindow.isDestroyed.mockReturnValue(false);
    mockHostWindow.on.mockImplementation((_event: string, listener: () => void) => {
      // Default: simulate synchronous window close so waitForWindowClosed resolves immediately
      listener();
    });
    mockHostWindow.once.mockImplementation((_event: string, listener: () => void) => {
      listener();
    });
    mockHostWindow.webContents.send.mockReset();
  });

  it('rejects immediately if the host request cannot be sent', async () => {
    const manager = new ChunkingHostManager() as unknown as TestableChunkingHostManager;
    mockHostWindow.webContents.send.mockImplementation(() => {
      throw new Error('webContents unavailable');
    });

    await expect(
      manager.chunkFile(11, {
        content: 'hello',
        fileName: 'a.txt',
        filePath: '/tmp/a.txt',
        fileRecordId: 'file-1',
        kind: 'chunk-file',
        options: {},
        requestId: 'req-1',
      })
    ).rejects.toThrow('Chunking host request req-1 could not be sent: webContents unavailable');

    expect(manager.requests.size()).toBe(0);
  });

  it('times out stale chunking requests instead of hanging forever', async () => {
    const manager = new ChunkingHostManager() as unknown as TestableChunkingHostManager;
    const requestPromise = manager.chunkBatch(11, {
      files: [],
      kind: 'chunk-batch',
      options: {},
      requestId: 'req-timeout',
    });
    const rejection = expect(requestPromise).rejects.toThrow(
      'Chunking host request req-timeout timed out after 30000ms.'
    );

    await vi.advanceTimersByTimeAsync(30_001);

    await rejection;
    expect(manager.requests.size()).toBe(0);
  });

  it('logs a late response at warn instead of dropping it silently', async () => {
    const manager = new ChunkingHostManager() as unknown as TestableChunkingHostManager;
    const requestPromise = manager.chunkFile(11, {
      content: 'hello',
      fileName: 'a.txt',
      filePath: '/tmp/a.txt',
      fileRecordId: 'file-1',
      kind: 'chunk-file',
      options: {},
      requestId: 'req-late',
    });
    const rejection = expect(requestPromise).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_001);
    await rejection;
    loggerWarnMock.mockClear();

    manager.acceptResponseReport(71, {
      channel: 'chunk-result',
      payload: { result: { chunks: [] } },
      requestId: 'req-late',
      runtimeId: 'chunking-host-runtime',
      type: 'result',
    });

    // `channel` and `type` are what identify which late report arrived.
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Received chunking host response for unknown request',
      { channel: 'chunk-result', requestId: 'req-late', type: 'result' }
    );
  });

  it('treats chunking progress as request liveness and keeps the request alive', async () => {
    const manager = new ChunkingHostManager() as unknown as TestableChunkingHostManager;
    const requestPromise = manager.chunkFile(11, {
      content: 'hello',
      fileName: 'a.txt',
      filePath: '/tmp/a.txt',
      fileRecordId: 'file-1',
      kind: 'chunk-file',
      options: {},
      requestId: 'req-progress-refresh',
    });
    await vi.advanceTimersByTimeAsync(20_000);

    manager.acceptResponseReport(71, {
      channel: 'chunk',
      payload: {
        chunksCreated: 0,
        fileRecordId: 'file-1',
      },
      requestId: 'req-progress-refresh',
      runtimeId: 'chunking-host-runtime',
      type: 'progress',
    });
    await vi.advanceTimersByTimeAsync(29_999);

    expect(manager.requests.has('req-progress-refresh')).toBe(true);

    manager.acceptResponseReport(71, {
      channel: 'chunk-result',
      payload: {
        result: { chunks: [] },
      },
      requestId: 'req-progress-refresh',
      runtimeId: 'chunking-host-runtime',
      type: 'result',
    });

    await expect(requestPromise).resolves.toEqual({ chunks: [] });
  });

  it('returns a defined error for unexpected response envelopes', async () => {
    const manager = new ChunkingHostManager() as unknown as TestableChunkingHostManager;
    const requestPromise = manager.chunkFile(11, {
      content: 'hello',
      fileName: 'a.txt',
      filePath: '/tmp/a.txt',
      fileRecordId: 'file-1',
      kind: 'chunk-file',
      options: {},
      requestId: 'req-unexpected',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.requests.has('req-unexpected')).toBe(true);

    manager.acceptResponseReport(71, {
      channel: 'unexpected-channel',
      payload: {},
      requestId: 'req-unexpected',
      runtimeId: 'chunking-host-runtime',
      type: 'result',
    });

    await expect(requestPromise).rejects.toThrow(
      'Unexpected chunking host response (type=result, channel=unexpected-channel).'
    );
  });

  it('falls back to errorMessage for chunking host error reports', async () => {
    const manager = new ChunkingHostManager() as unknown as TestableChunkingHostManager;
    const requestPromise = manager.chunkFile(11, {
      content: 'hello',
      fileName: 'a.txt',
      filePath: '/tmp/a.txt',
      fileRecordId: 'file-1',
      kind: 'chunk-file',
      options: {},
      requestId: 'req-error',
    });
    await vi.advanceTimersByTimeAsync(0);

    manager.acceptResponseReport(71, {
      channel: 'chunk',
      payload: {
        errorMessage: 'chunking failed',
      },
      requestId: 'req-error',
      runtimeId: 'chunking-host-runtime',
      type: 'error',
    });

    await expect(requestPromise).rejects.toThrow('chunking failed');
  });

  it('creates a fresh error for each rejected pending request during shutdown', async () => {
    const manager = new ChunkingHostManager() as unknown as TestableChunkingHostManager;

    const firstPromise = manager.chunkFile(11, {
      content: 'hello',
      fileName: 'a.txt',
      filePath: '/tmp/a.txt',
      fileRecordId: 'file-1',
      kind: 'chunk-file',
      options: {},
      requestId: 'req-first',
    });
    const secondPromise = manager.chunkFile(11, {
      content: 'hello',
      fileName: 'b.txt',
      filePath: '/tmp/b.txt',
      fileRecordId: 'file-2',
      kind: 'chunk-file',
      options: {},
      requestId: 'req-second',
    });

    await vi.advanceTimersByTimeAsync(0);
    await manager.stop();

    const [firstError, secondError] = await Promise.all([
      firstPromise.catch((error: Error) => error),
      secondPromise.catch((error: Error) => error),
    ]);

    expect(firstError).toBeInstanceOf(Error);
    expect(secondError).toBeInstanceOf(Error);
    if (!(firstError instanceof Error)) {
      throw new Error('expected first chunking shutdown error');
    }
    if (!(secondError instanceof Error)) {
      throw new Error('expected second chunking shutdown error');
    }
    expect(firstError).not.toBe(secondError);
    expect(firstError.message).toBe('Chunking host stopped while requests were in flight.');
    expect(secondError.message).toBe('Chunking host stopped while requests were in flight.');
  });

  it('explains when the host window disappears after startup', async () => {
    const manager = new ChunkingHostManager() as unknown as TestableChunkingHostManager;
    lifecycleState.getHostWindow.mockReturnValueOnce(null);

    await expect(
      manager.chunkBatch(11, {
        files: [],
        kind: 'chunk-batch',
        options: {},
        requestId: 'req-lost-window',
      })
    ).rejects.toThrow('Chunking host window became unavailable after startup completed.');
  });

  it('ignores requester windows destroyed during progress forwarding', async () => {
    const requesterWindow = {
      id: 88,
      isDestroyed: vi.fn(() => false),
      webContents: {
        id: 11,
        send: vi.fn(() => {
          throw new Error('window destroyed during send');
        }),
      },
    };
    getAllWindowsMock.mockReturnValue([requesterWindow]);

    const manager = new ChunkingHostManager() as unknown as TestableChunkingHostManager;

    expect(() =>
      manager.acceptResponseReport(71, {
        channel: 'chunking-host:progress:chunked',
        payload: {
          completedFiles: 1,
          totalFiles: 3,
        },
        requestId: 'req-progress',
        runtimeId: 'chunking-host-runtime',
        type: 'progress',
      })
    ).not.toThrow();
  });

  it('reuses the captured requester window for progress forwarding', async () => {
    const requesterWindow = {
      id: 88,
      isDestroyed: vi.fn(() => false),
      webContents: {
        id: 11,
        send: vi.fn(),
      },
    };
    getAllWindowsMock.mockReturnValue([requesterWindow]);

    const manager = new ChunkingHostManager() as unknown as TestableChunkingHostManager;
    const requestPromise = manager.chunkFile(11, {
      content: 'hello',
      fileName: 'a.txt',
      filePath: '/tmp/a.txt',
      fileRecordId: 'file-1',
      kind: 'chunk-file',
      options: {},
      requestId: 'req-progress-cached',
    });
    await vi.advanceTimersByTimeAsync(0);

    getAllWindowsMock.mockReturnValue([]);

    manager.acceptResponseReport(71, {
      channel: 'chunking-host:progress:chunked',
      payload: {
        completedFiles: 1,
        totalFiles: 1,
      },
      requestId: 'req-progress-cached',
      runtimeId: 'chunking-host-runtime',
      type: 'progress',
    });

    expect(requesterWindow.webContents.send).toHaveBeenCalledWith(
      'chunking-host:progress',
      expect.objectContaining({
        requestId: 'req-progress-cached',
        type: 'progress',
      })
    );

    manager.acceptResponseReport(71, {
      channel: 'chunk-result',
      payload: {
        result: { chunks: [] },
      },
      requestId: 'req-progress-cached',
      runtimeId: 'chunking-host-runtime',
      type: 'result',
    });

    await expect(requestPromise).resolves.toEqual({ chunks: [] });
  });

  it('stop joins the lifecycle release before reporting stopped', async () => {
    const physical = Promise.withResolvers<void>();
    lifecycleState.destroyHostWindow.mockReturnValueOnce(physical.promise);
    const manager = new ChunkingHostManager();
    let settled = false;
    const stop = manager.stop().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(lifecycleState.destroyHostWindow).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    physical.resolve();
    await stop;
    expect(settled).toBe(true);
  });

  it('does not turn the old window-close timeout into successful Stop', async () => {
    const physical = Promise.withResolvers<void>();
    lifecycleState.destroyHostWindow.mockReturnValueOnce(physical.promise);
    const manager = new ChunkingHostManager();
    let settled = false;
    const stop = manager.stop().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    physical.resolve();
    await stop;
  });

  it('joins the existing release even when the BrowserWindow is already marked destroyed', async () => {
    mockHostWindow.isDestroyed.mockReturnValue(true);
    const physical = Promise.withResolvers<void>();
    lifecycleState.destroyHostWindow.mockReturnValueOnce(physical.promise);
    const manager = new ChunkingHostManager();
    let settled = false;
    const stop = manager.stop().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    physical.resolve();
    await stop;
    expect(lifecycleState.stop).toHaveBeenCalledOnce();
  });

  it('dispose retires the lifecycle even when stop fails, and still rejects', async () => {
    const manager = new ChunkingHostManager();
    const failure = new Error('destroy failed');
    lifecycleState.destroyHostWindow.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(manager.dispose()).rejects.toBe(failure);
    expect(lifecycleState.dispose).toHaveBeenCalledTimes(1);
  });
});
