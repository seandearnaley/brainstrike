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
    getAllWindowsMock: vi.fn(() => []),
    lifecycleState: {
      clearHostWindow: vi.fn(),
      destroyHostWindow: vi.fn(),
      dispose: vi.fn(),
      ensureStarted: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'chunking-host-runtime',
        state: 'running' as const,
      })),
      getHostWindow: vi.fn(() => hostWindow),
      getStatus: vi.fn(() => ({
        active: false,
        lastError: null,
        runtimeId: 'chunking-host-runtime',
        state: 'running' as const,
      })),
      isHostWindow: vi.fn(() => false),
      setStatus: vi.fn(),
      waitForStatus: vi.fn(),
    },
    mockHostWindow: hostWindow,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
}));

vi.mock('../renderer-host-lifecycle', () => ({
  RendererHostLifecycle: vi.fn().mockImplementation(function MockRendererHostLifecycle() {
    return lifecycleState;
  }),
}));

import { ChunkingHostManager } from '../chunking-host-manager';

type TestableChunkingHostManager = ChunkingHostManager & {
  acceptResponseReport(
    senderId: number,
    report: {
      channel: string;
      payload: Record<string, unknown>;
      requestId: string;
      runtimeId: string;
      type: string;
    }
  ): void;
  pendingRequests: Map<string, unknown>;
};

describe('ChunkingHostManager', () => {
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
    const manager = new ChunkingHostManager() as TestableChunkingHostManager;
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

    expect(manager.pendingRequests.size).toBe(0);
  });

  it('times out stale chunking requests instead of hanging forever', async () => {
    const manager = new ChunkingHostManager() as TestableChunkingHostManager;
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
    expect(manager.pendingRequests.size).toBe(0);
  });

  it('treats chunking progress as request liveness and keeps the request alive', async () => {
    const manager = new ChunkingHostManager() as TestableChunkingHostManager;
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

    expect(manager.pendingRequests.has('req-progress-refresh')).toBe(true);

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
    const manager = new ChunkingHostManager() as TestableChunkingHostManager;
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
    expect(manager.pendingRequests.has('req-unexpected')).toBe(true);

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
    const manager = new ChunkingHostManager() as TestableChunkingHostManager;
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
    const manager = new ChunkingHostManager() as TestableChunkingHostManager;

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
    expect(firstError).not.toBe(secondError);
    expect(firstError.message).toBe('Chunking host stopped while requests were in flight.');
    expect(secondError.message).toBe('Chunking host stopped while requests were in flight.');
  });

  it('explains when the host window disappears after startup', async () => {
    const manager = new ChunkingHostManager() as TestableChunkingHostManager;
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

    const manager = new ChunkingHostManager() as TestableChunkingHostManager;

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

    const manager = new ChunkingHostManager() as TestableChunkingHostManager;
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

  it('stop waits for the closed event before resolving', async () => {
    vi.useRealTimers();
    let closedListener: (() => void) | null = null;
    mockHostWindow.on.mockImplementation((event: string, listener: () => void) => {
      if (event === 'closed') {
        closedListener = listener;
      }
    });

    const manager = new ChunkingHostManager();
    const stopPromise = manager.stop();

    // The stop should not resolve until the closed event fires
    await Promise.resolve();
    expect(closedListener).not.toBeNull();

    closedListener!();
    await stopPromise;

    expect(lifecycleState.destroyHostWindow).toHaveBeenCalled();
    expect(lifecycleState.clearHostWindow).toHaveBeenCalled();
  });

  it('stop resolves within timeout if closed event never fires', async () => {
    vi.useFakeTimers();
    mockHostWindow.once.mockImplementation(() => {
      // Never call the listener — simulating a window that never fires 'closed'
    });

    const manager = new ChunkingHostManager();
    const stopPromise = manager.stop();

    await vi.advanceTimersByTimeAsync(500);
    await stopPromise;

    expect(lifecycleState.destroyHostWindow).toHaveBeenCalled();
    expect(lifecycleState.clearHostWindow).toHaveBeenCalled();
  });

  it('stop resolves immediately if window is already destroyed', async () => {
    vi.useRealTimers();
    mockHostWindow.isDestroyed.mockReturnValue(true);

    const manager = new ChunkingHostManager();
    await manager.stop();

    // destroyHostWindow should NOT be called because the window is already destroyed
    expect(lifecycleState.destroyHostWindow).not.toHaveBeenCalled();
    expect(lifecycleState.clearHostWindow).toHaveBeenCalled();
  });
});
