import { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT,
  EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL,
  EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL,
} from '../../embedding-host-shared';

function createWindowWithWebContents(sender: {
  send: (...args: unknown[]) => unknown;
}): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: sender,
  } as unknown as BrowserWindow;
}

// Hoist Electron and db mocks safely
const {
  handlers,
  mockDb,
  getDatabaseMock,
  loggerWarn,
  isCorruptionErrorMock,
  handleRuntimeCorruptionMock,
  resetLocalDatabaseMock,
  getDatabaseDiagnosticsMock,
  enqueueEmbeddingBackfillMock,
  embeddingHostEnsureStartedMock,
  embeddingHostGetStatusMock,
  embeddingHostResetMock,
  embeddingHostStopMock,
  embeddingHostDestroyAndRestartMock,
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockDb = {
    query: vi.fn(),
    exec: vi.fn(),
    transaction: vi.fn(),
    live: {
      query: vi.fn(),
      incrementalQuery: vi.fn(),
    },
  };
  const getDatabaseMock = vi.fn(() => mockDb);
  const loggerWarn = vi.fn();
  const isCorruptionErrorMock = vi.fn(() => false);
  const handleRuntimeCorruptionMock = vi.fn();
  const resetLocalDatabaseMock = vi.fn();
  const enqueueEmbeddingBackfillMock = vi.fn();
  const embeddingHostEnsureStartedMock = vi.fn(async () => ({
    state: 'running' as const,
    active: false,
    lastError: null,
  }));
  const embeddingHostGetStatusMock = vi.fn(() => ({
    state: 'running' as const,
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
  }));
  const embeddingHostResetMock = vi.fn(async () => ({
    state: 'running' as const,
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
  }));
  const embeddingHostStopMock = vi.fn(async () => ({
    state: 'stopped' as const,
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
  }));
  const embeddingHostDestroyAndRestartMock = vi.fn(async () => ({
    state: 'running' as const,
    active: false,
    lastError: null,
    runtimeId: 'embedding-host-runtime',
  }));
  const getDatabaseDiagnosticsMock = vi.fn(() => ({
    databaseProfile: 'test',
    dataDir: '/mock/documents/BrainStrike-dev/profiles/test/pgdata',
    appDataDir: '/mock/documents/BrainStrike-dev/profiles/test',
    nodeEnv: 'test',
    initializationAttemptCount: 1,
    initializationInFlight: false,
    hasDatabaseHandle: true,
    databaseLockHeld: true,
    databaseLockPath: '/mock/documents/BrainStrike-dev/profiles/test/.db-process.lock',
    lastInitializationStartedAt: '2026-02-15T00:00:00.000Z',
    lastInitializationSucceededAt: '2026-02-15T00:00:01.000Z',
    lastInitializationFailure: null,
    runtimeCorruptionRecoveryCount: 0,
    lastRuntimeCorruptionAt: null,
    lastRuntimeCorruptionContext: null,
  }));
  return {
    handlers,
    mockDb,
    getDatabaseMock,
    loggerWarn,
    isCorruptionErrorMock,
    handleRuntimeCorruptionMock,
    resetLocalDatabaseMock,
    getDatabaseDiagnosticsMock,
    enqueueEmbeddingBackfillMock,
    embeddingHostEnsureStartedMock,
    embeddingHostGetStatusMock,
    embeddingHostResetMock,
    embeddingHostStopMock,
    embeddingHostDestroyAndRestartMock,
  };
});

vi.mock('electron', async () => {
  const electronUtils = await import('@brainstrike/test-utils');
  const typedIpcMain = electronUtils.createIpcMainMock();
  Object.assign(typedIpcMain, {
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn(),
  });
  // Track handlers for direct invocation
  typedIpcMain.handle.mockImplementation(
    (channel: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(channel, listener);
    }
  );
  const app = electronUtils.createAppMock({
    whenReadyResolved: true,
    documentsPath: '/mock/documents',
  });
  const mockBrowserWindowInstance = {
    once: vi.fn(),
    on: vi.fn(),
    show: vi.fn(),
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    maximize: vi.fn(),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1536, height: 800 })),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1536, height: 800 })),
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      openDevTools: vi.fn(),
    },
  };
  const BrowserWindow = Object.assign(vi.fn(), {
    getAllWindows: vi.fn(() => []),
  });
  BrowserWindow.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, mockBrowserWindowInstance);
  });
  return {
    ipcMain: typedIpcMain,
    app,
    BrowserWindow,
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
    Menu: {
      setApplicationMenu: vi.fn(),
      buildFromTemplate: vi.fn(),
    },
    screen: {
      getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1080 } })),
      getAllDisplays: vi.fn(() => []),
    },
    powerMonitor: {
      on: vi.fn(),
    },
    powerSaveBlocker: {
      start: vi.fn(() => 1),
      isStarted: vi.fn(() => true),
      stop: vi.fn(),
    },
  };
});

vi.mock('../../db-main', () => ({
  getDatabase: getDatabaseMock,
  isCorruptionError: isCorruptionErrorMock,
  handleRuntimeCorruption: handleRuntimeCorruptionMock,
  resetLocalDatabase: resetLocalDatabaseMock,
  getDatabaseDiagnostics: getDatabaseDiagnosticsMock,
}));

vi.mock('../../embedding-backfill', () => ({
  enqueueEmbeddingBackfill: enqueueEmbeddingBackfillMock,
}));

vi.mock('../../embedding-host-manager', () => ({
  EmbeddingHostManager: class MockEmbeddingHostManager {
    acceptStatusReport = vi.fn();
    dispose = vi.fn(async () => {});
    ensureStarted = embeddingHostEnsureStartedMock;
    getStatus = embeddingHostGetStatusMock;
    isHostWindow = vi.fn(() => false);
    reset = embeddingHostResetMock;
    stop = embeddingHostStopMock;
    destroyAndRestart = embeddingHostDestroyAndRestartMock;
  },
}));

vi.mock('@brainstrike/utils/logger', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils/logger')>(
    '@brainstrike/utils/logger'
  );
  return {
    ...actual,
    createLogger: () => ({
      warn: loggerWarn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

// Use function syntax for Vitest 4 constructor mocks
vi.mock('@brainstrike/file-system/electron', () => {
  const MockAdapter = vi.fn();
  MockAdapter.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {});
  });
  return { ElectronFileSystemAdapter: MockAdapter };
});

vi.mock('@brainstrike/storage/electron', () => {
  const MockAdapter = vi.fn();
  MockAdapter.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {});
  });
  return { ElectronStorageAdapter: MockAdapter };
});

// Use function syntax for Vitest 4 constructor mocks
vi.mock('electron-store', () => {
  const MockElectronStore = vi.fn();
  MockElectronStore.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {});
  });
  return { default: MockElectronStore };
});

import '../../main';

describe('database IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_EMBED_GPU_RECLAIM_CHECK_INTERVAL_MS');
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED');
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE');
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD');
    embeddingHostEnsureStartedMock.mockResolvedValue({
      state: 'running',
      active: false,
      lastError: null,
      runtimeId: 'embedding-host-runtime',
    });
    embeddingHostGetStatusMock.mockReturnValue({
      state: 'running',
      active: false,
      lastError: null,
      runtimeId: 'embedding-host-runtime',
    });
    embeddingHostResetMock.mockResolvedValue({
      state: 'running',
      active: false,
      lastError: null,
      runtimeId: 'embedding-host-runtime',
    });
    embeddingHostStopMock.mockResolvedValue({
      state: 'stopped',
      active: false,
      lastError: null,
      runtimeId: 'embedding-host-runtime',
    });
    embeddingHostDestroyAndRestartMock.mockResolvedValue({
      state: 'running',
      active: false,
      lastError: null,
      runtimeId: 'embedding-host-runtime',
    });
  });

  it('db:query calls query and returns result', async () => {
    const handler = handlers.get('db:query');
    const rows = { rows: [{ id: 1 }] };
    mockDb.query.mockResolvedValue(rows);

    const result = await handler?.({} as unknown, 'SELECT 1', [1]);

    expect(getDatabaseMock).toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledWith('SELECT 1', [1]);
    expect(result).toBe(rows);
  });

  it('db:query throws on error', async () => {
    const handler = handlers.get('db:query');
    const err = new Error('fail');
    mockDb.query.mockRejectedValue(err);

    await expect(handler?.({} as unknown, 'BAD')).rejects.toThrow(err);
  });

  it('db:exec calls exec and returns result', async () => {
    const handler = handlers.get('db:exec');
    const ret = { done: true };
    mockDb.exec.mockResolvedValue(ret);

    const result = await handler?.({} as unknown, 'CREATE TABLE');

    expect(getDatabaseMock).toHaveBeenCalled();
    expect(mockDb.exec).toHaveBeenCalledWith('CREATE TABLE');
    expect(result).toBe(ret);
  });

  it('db:exec throws on error', async () => {
    const handler = handlers.get('db:exec');
    const err = new Error('exec fail');
    mockDb.exec.mockRejectedValue(err);

    await expect(handler?.({} as unknown, 'BAD')).rejects.toThrow(err);
  });

  it('embedding-host:enqueue-backfill runs backfill in main and streams progress', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        onProgress: (done: number, total: number) => void
      ) => {
        onProgress(0, 450);
        onProgress(128, 450);
        onProgress(450, 450);
        return {
          queued: 450,
          running: 0,
          failed: 0,
          succeeded: 0,
        };
      }
    );

    const result = await handler({ sender } as unknown, 'set-123');

    expect(embeddingHostEnsureStartedMock).toHaveBeenCalledWith({ waitForRunning: true });
    expect(getDatabaseMock).toHaveBeenCalledTimes(1);
    expect(enqueueEmbeddingBackfillMock).toHaveBeenCalledTimes(1);
    expect(enqueueEmbeddingBackfillMock).toHaveBeenCalledWith(
      mockDb,
      expect.any(Object),
      'set-123',
      expect.any(Function),
      expect.objectContaining({
        assertCanContinue: expect.any(Function),
        progressIntervalBatches: 4,
        progressIntervalMs: 250,
      })
    );
    expect(sender.send).toHaveBeenCalledWith(EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT, {
      embeddingSetId: 'set-123',
      requestId: expect.stringMatching(/^embedding-backfill:/),
      stage: 'backfill',
      current: 0,
      total: 450,
    });
    expect(sender.send).toHaveBeenLastCalledWith(EMBEDDING_HOST_BACKFILL_PROGRESS_EVENT, {
      embeddingSetId: 'set-123',
      requestId: expect.stringMatching(/^embedding-backfill:/),
      stage: 'backfill',
      current: 450,
      total: 450,
    });
    expect(result).toEqual({
      queued: 450,
      running: 0,
      failed: 0,
      succeeded: 0,
    });
  });

  it('embedding-host:enqueue-backfill does not run maintenance when reclaim is disabled', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED'] = 'false';

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockResolvedValueOnce({
      queued: 8,
      running: 0,
      failed: 0,
      succeeded: 8,
    });

    const result = await handler({ sender } as unknown, 'set-123');

    expect(embeddingHostResetMock).not.toHaveBeenCalled();
    expect(embeddingHostStopMock).not.toHaveBeenCalled();
    expect(embeddingHostDestroyAndRestartMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      queued: 8,
      running: 0,
      failed: 0,
      succeeded: 8,
    });
  });

  it('embedding-host:enqueue-backfill rejects invalid GPU reclaim enabled env values', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED'] = 'maybe';

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    await expect(handler({ sender } as unknown, 'set-123')).rejects.toThrow(
      'BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED must be set to one of: "true", "false", "1", or "0" when configured.'
    );
    expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill rejects invalid GPU reclaim threshold env values', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD'] = '0';

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    await expect(handler({ sender } as unknown, 'set-123')).rejects.toThrow(
      'BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD must be a positive integer when configured.'
    );
    expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill rejects invalid GPU reclaim interval env values', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_CHECK_INTERVAL_MS'] = '0';

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    await expect(handler({ sender } as unknown, 'set-123')).rejects.toThrow(
      'BRAINSTRIKE_EMBED_GPU_RECLAIM_CHECK_INTERVAL_MS must be a positive integer when configured.'
    );
    expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill rejects invalid GPU reclaim mode env values', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE'] = 'maybe';

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    await expect(handler({ sender } as unknown, 'set-123')).rejects.toThrow(
      'BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE must be set to "reset" when configured.'
    );
    expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
    expect(embeddingHostEnsureStartedMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill leaves no in-flight state after invalid reclaim config', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD'] = '0';
    await expect(handler({ sender } as unknown, 'set-123')).rejects.toThrow(
      'BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD must be a positive integer when configured.'
    );

    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD');
    enqueueEmbeddingBackfillMock.mockResolvedValueOnce({
      queued: 1,
      running: 0,
      failed: 0,
      succeeded: 1,
    });

    await expect(handler({ sender } as unknown, 'set-123')).resolves.toEqual({
      queued: 1,
      running: 0,
      failed: 0,
      succeeded: 1,
    });
  });

  it('embedding-host:enqueue-backfill runs planned maintenance from drain ticks using reset mode', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED'] = 'true';
    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD'] = '2';
    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE'] = 'reset';

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        _onProgress: (done: number, total: number) => void,
        options: { onDrainTick?: (completedSinceLastTick: number) => Promise<void> }
      ) => {
        await options.onDrainTick?.(1);
        await options.onDrainTick?.(1);
        return {
          queued: 2,
          running: 0,
          failed: 0,
          succeeded: 2,
        };
      }
    );

    await expect(handler({ sender } as unknown, 'set-123')).resolves.toEqual({
      queued: 2,
      running: 0,
      failed: 0,
      succeeded: 2,
    });
    expect(embeddingHostResetMock).toHaveBeenCalledTimes(1);
    expect(embeddingHostStopMock).not.toHaveBeenCalled();
    expect(embeddingHostDestroyAndRestartMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill defaults to reclaim disabled when no env is provided', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        _onProgress: (done: number, total: number) => void,
        options: { onDrainTick?: (completedSinceLastTick: number) => Promise<void> }
      ) => {
        await options.onDrainTick?.(1);
        return {
          queued: 1,
          running: 0,
          failed: 0,
          succeeded: 1,
        };
      }
    );

    await expect(handler({ sender } as unknown, 'set-123')).resolves.toEqual({
      queued: 1,
      running: 0,
      failed: 0,
      succeeded: 1,
    });
    expect(embeddingHostResetMock).not.toHaveBeenCalled();
    expect(embeddingHostStopMock).not.toHaveBeenCalled();
    expect(embeddingHostDestroyAndRestartMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill resolves cleanly after an explicit cancel-all request', async () => {
    const backfillHandler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    const cancelHandler = handlers.get(EMBEDDING_HOST_CANCEL_ALL_BACKFILLS_CHANNEL);
    if (!(backfillHandler && cancelHandler)) {
      throw new Error('required handlers not registered');
    }

    mockDb.query.mockResolvedValue({ rows: [] });

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        _onProgress: (done: number, total: number) => void,
        options: {
          assertCanContinue?: () => void | Promise<void>;
        }
      ) => {
        await cancelHandler({} as unknown);
        await options.assertCanContinue?.();
        return {
          queued: 99,
          running: 99,
          failed: 99,
          succeeded: 99,
        };
      }
    );

    await expect(backfillHandler({ sender } as unknown, 'set-123')).resolves.toEqual({
      queued: 0,
      running: 0,
      failed: 0,
      succeeded: 0,
    });
  });

  it('embedding-host:enqueue-backfill treats reset maintenance interruption as planned', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED'] = 'true';
    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD'] = '2';
    process.env['BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE'] = 'reset';

    let resolveReset: (() => void) | null = null;
    embeddingHostResetMock.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveReset = () =>
            resolve({
              state: 'running' as const,
              active: false,
              lastError: null,
              runtimeId: 'embedding-host-runtime',
            });
        })
    );

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        _onProgress: (done: number, total: number) => void,
        options: {
          assertCanContinue?: () => void | Promise<void>;
          onDrainTick?: (completedSinceLastTick: number) => Promise<void>;
        }
      ) => {
        if (!(options.assertCanContinue && options.onDrainTick)) {
          throw new Error('Missing maintenance callbacks');
        }
        embeddingHostGetStatusMock.mockReturnValue({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host-runtime',
        });
        const maintenancePromise = options.onDrainTick(2);
        expect(() => {
          void options.assertCanContinue();
        }).not.toThrow();
        resolveReset?.();
        await maintenancePromise;
        embeddingHostGetStatusMock.mockReturnValue({
          state: 'running',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host-runtime',
        });
        return {
          queued: 2,
          running: 0,
          failed: 0,
          succeeded: 2,
        };
      }
    );

    await expect(handler({ sender } as unknown, 'set-123')).resolves.toEqual({
      queued: 2,
      running: 0,
      failed: 0,
      succeeded: 2,
    });
    expect(embeddingHostResetMock).toHaveBeenCalledTimes(1);
  });

  it('embedding-host:enqueue-backfill still fails fast on unexpected host stop', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        _onProgress: (done: number, total: number) => void,
        options: { assertCanContinue?: () => void | Promise<void> }
      ) => {
        embeddingHostGetStatusMock.mockReturnValue({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host-runtime',
        });
        await options.assertCanContinue?.();
        return {
          queued: 0,
          running: 0,
          failed: 0,
          succeeded: 0,
        };
      }
    );

    await expect(handler({ sender } as unknown, 'set-123')).rejects.toThrow(
      'Embedding host stopped while backfill was in progress.'
    );
  });

  it('embedding-host:enqueue-backfill stops progress sends after the renderer frame is disposed', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('Render frame was disposed before WebFrameMain could be accessed');
        })
        .mockImplementation(() => undefined),
      once: vi.fn(),
    };

    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async (
        _db: unknown,
        _jobQueue: unknown,
        _embeddingSetId: string,
        onProgress: (done: number, total: number) => void
      ) => {
        onProgress(0, 450);
        onProgress(128, 450);
        onProgress(450, 450);
        return {
          queued: 450,
          running: 0,
          failed: 0,
          succeeded: 0,
        };
      }
    );

    const result = await handler({ sender } as unknown, 'set-123');

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      queued: 450,
      running: 0,
      failed: 0,
      succeeded: 0,
    });
  });

  it('embedding-host:enqueue-backfill fails fast when the embedding host cannot reach running', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    embeddingHostEnsureStartedMock.mockResolvedValueOnce({
      state: 'error',
      active: false,
      lastError: 'host failed to start',
    });

    const sender = {
      id: 44,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    await expect(handler({ sender } as unknown, 'set-123')).rejects.toThrow('host failed to start');
    expect(enqueueEmbeddingBackfillMock).not.toHaveBeenCalled();
  });

  it('embedding-host:enqueue-backfill rejects concurrent submissions for the same set', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    let resolveBackfill: (() => void) | null = null;
    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveBackfill = () => resolve(undefined);
        })
    );

    const sender = {
      id: 45,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    const first = handler({ sender } as unknown, 'set-a');
    await expect(handler({ sender } as unknown, 'set-a')).rejects.toThrow(
      'Embedding backfill is already running for set set-a.'
    );
    resolveBackfill?.();
    await first;
  });

  it('embedding-host:enqueue-backfill allows concurrent submissions for different sets', async () => {
    const handler = handlers.get(EMBEDDING_HOST_ENQUEUE_BACKFILL_CHANNEL);
    if (!handler) {
      throw new Error('handler not registered');
    }

    let markFirstBackfillStarted: (() => void) | null = null;
    const firstBackfillStarted = new Promise<void>((resolve) => {
      markFirstBackfillStarted = resolve;
    });
    let resolveFirstBackfill: (() => void) | null = null;
    enqueueEmbeddingBackfillMock.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          markFirstBackfillStarted?.();
          resolveFirstBackfill = () =>
            resolve({
              failed: 0,
              queued: 450,
              running: 0,
              succeeded: 0,
            });
        })
    );
    enqueueEmbeddingBackfillMock.mockImplementationOnce(async () => ({
      failed: 0,
      queued: 450,
      running: 0,
      succeeded: 0,
    }));

    const sender = {
      id: 46,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    const first = handler({ sender } as unknown, 'set-a');
    await firstBackfillStarted;
    const second = handler({ sender } as unknown, 'set-b');

    await expect(second).resolves.toEqual({
      failed: 0,
      queued: 450,
      running: 0,
      succeeded: 0,
    });
    resolveFirstBackfill?.();
    await expect(first).resolves.toEqual({
      failed: 0,
      queued: 450,
      running: 0,
      succeeded: 0,
    });
  });

  it('db:live-query:start subscribes and forwards updates', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    let listener: ((results: unknown) => void) | null = null;
    const liveHandle = {
      initialResults: { rows: [{ id: 1 }] },
      subscribe: vi.fn((cb: (results: unknown) => void) => {
        listener = cb;
      }),
      unsubscribe: vi.fn(),
      refresh: vi.fn(),
    };
    mockDb.live.query.mockResolvedValue(liveHandle);

    const sender = {
      id: 22,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn((_event: string, _cb: () => void) => {}),
    };

    const result = (await handler({ sender } as unknown, { query: 'select 1', params: [1] })) as {
      id: number;
      initialResults: unknown;
    };

    expect(mockDb.live.query).toHaveBeenCalledWith({
      query: 'select 1',
      params: [1],
      offset: undefined,
      limit: undefined,
    });
    expect(result.initialResults).toEqual({ rows: [{ id: 1 }] });

    listener?.({ rows: [{ id: 2 }] });
    // Live query updates are dedup+batched; flush to deliver pending sends.
    const { flushPendingLiveUpdates } = await import('../../ipc-handlers');
    const getAllWindowsMock = vi.mocked(BrowserWindow.getAllWindows);
    getAllWindowsMock.mockReturnValue([createWindowWithWebContents(sender)]);
    flushPendingLiveUpdates();
    expect(sender.send).toHaveBeenCalledWith('db:live-query:update', {
      id: result.id,
      results: { rows: [{ id: 2 }] },
    });

    const stopHandler = handlers.get('db:live-query:stop');
    await stopHandler?.({} as unknown, result.id);
    expect(liveHandle.unsubscribe).toHaveBeenCalled();
  });

  it('db:live-query:start registers a single destroyed listener per webContents', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    const firstHandle = {
      initialResults: { rows: [] },
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      refresh: vi.fn(),
    };
    const secondHandle = {
      initialResults: { rows: [] },
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      refresh: vi.fn(),
    };
    mockDb.live.query.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(secondHandle);

    const sender = {
      id: 101,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn(),
    };

    await handler({ sender } as unknown, { query: 'select 1' });
    await handler({ sender } as unknown, { query: 'select 2' });

    expect(sender.once).toHaveBeenCalledTimes(1);
    expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
  });

  it('db:live-query:start supports incremental mode with key', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    const liveHandle = {
      initialResults: { rows: [] },
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      refresh: vi.fn(),
    };
    mockDb.live.incrementalQuery.mockResolvedValue(liveHandle);

    await handler(
      { sender: { id: 1, isDestroyed: () => false, send: vi.fn(), once: vi.fn() } } as unknown,
      { query: 'select *', key: 'id', mode: 'incremental', offset: 2, limit: 5 }
    );

    expect(mockDb.live.incrementalQuery).toHaveBeenCalledWith({
      query: 'select *',
      params: null,
      key: 'id',
      offset: 2,
      limit: 5,
    });
  });

  it('db:live-query:start throws when incremental key is missing', async () => {
    const handler = handlers.get('db:live-query:start');
    if (!handler) {
      throw new Error('handler not registered');
    }

    await expect(
      handler(
        { sender: { id: 1, isDestroyed: () => false, send: vi.fn(), once: vi.fn() } } as unknown,
        { query: 'select *', mode: 'incremental' }
      )
    ).rejects.toThrow('Live incremental queries require a key column');
  });

  it('db:live-query:refresh returns not found when subscription missing', async () => {
    const handler = handlers.get('db:live-query:refresh');

    const result = await handler?.({} as unknown, { id: 999 });

    expect(result).toEqual({ success: false, message: 'Subscription not found' });
  });

  it('db:live-query:refresh handles corruption errors', async () => {
    const startHandler = handlers.get('db:live-query:start');
    const refreshHandler = handlers.get('db:live-query:refresh');
    if (!(startHandler && refreshHandler)) {
      throw new Error('handler not registered');
    }

    const liveHandle = {
      initialResults: { rows: [] },
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      refresh: vi.fn(),
    };
    mockDb.live.query.mockResolvedValue(liveHandle);

    const sender = {
      id: 77,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn((_event: string, _cb: () => void) => {}),
    };

    const result = (await startHandler({ sender } as unknown, { query: 'select 1' })) as {
      id: number;
    };

    const error = new Error('corrupted');
    liveHandle.refresh.mockRejectedValue(error);
    isCorruptionErrorMock.mockReturnValueOnce(true);

    const refreshResult = await refreshHandler({} as unknown, { id: result.id });

    expect(handleRuntimeCorruptionMock).toHaveBeenCalledWith('db:live-query:refresh');
    expect(refreshResult).toEqual({
      success: false,
      message: 'Database was corrupted and has been reset. Please reload the application.',
      corrupted: true,
    });
  });

  it('db:live-query:refresh returns error message for non-corruption errors', async () => {
    const startHandler = handlers.get('db:live-query:start');
    const refreshHandler = handlers.get('db:live-query:refresh');
    if (!(startHandler && refreshHandler)) {
      throw new Error('handler not registered');
    }

    const liveHandle = {
      initialResults: { rows: [] },
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      refresh: vi.fn(),
    };
    mockDb.live.query.mockResolvedValue(liveHandle);

    const sender = {
      id: 55,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn((_event: string, _cb: () => void) => {}),
    };

    const result = (await startHandler({ sender } as unknown, { query: 'select 1' })) as {
      id: number;
    };

    liveHandle.refresh.mockRejectedValue(new Error('refresh failed'));
    isCorruptionErrorMock.mockReturnValueOnce(false);

    const refreshResult = await refreshHandler({} as unknown, { id: result.id, offset: 1 });

    expect(refreshResult).toEqual({
      success: false,
      message: 'refresh failed',
    });
  });

  it('db:resetLocal returns success and errors', async () => {
    const handler = handlers.get('db:resetLocal');
    if (!handler) {
      throw new Error('handler not registered');
    }

    resetLocalDatabaseMock.mockResolvedValueOnce(undefined);
    await expect(handler({} as unknown)).resolves.toEqual({ success: true });

    resetLocalDatabaseMock.mockRejectedValueOnce(new Error('fail reset'));
    await expect(handler({} as unknown)).resolves.toEqual({
      success: false,
      message: 'fail reset',
    });
  });

  it('db:getUserDataPath returns expected paths', async () => {
    const handler = handlers.get('db:getUserDataPath');
    if (!handler) {
      throw new Error('handler not registered');
    }

    const originalEnv = process.env['NODE_ENV'];

    process.env['NODE_ENV'] = 'test';
    const testPath = await handler({} as unknown);
    expect(String(testPath)).toContain('pgdata');

    process.env['NODE_ENV'] = 'production';
    const prodPath = await handler({} as unknown);
    expect(String(prodPath)).toContain('BrainStrike');

    process.env['NODE_ENV'] = originalEnv;
  });

  it('db:diagnostics returns main-process diagnostics snapshot', async () => {
    const handler = handlers.get('db:diagnostics');
    if (!handler) {
      throw new Error('handler not registered');
    }

    const result = await handler({} as unknown);

    expect(getDatabaseDiagnosticsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      databaseProfile: 'test',
      dataDir: '/mock/documents/BrainStrike-dev/profiles/test/pgdata',
      appDataDir: '/mock/documents/BrainStrike-dev/profiles/test',
      nodeEnv: 'test',
      initializationAttemptCount: 1,
      initializationInFlight: false,
      hasDatabaseHandle: true,
      databaseLockHeld: true,
      databaseLockPath: '/mock/documents/BrainStrike-dev/profiles/test/.db-process.lock',
      lastInitializationStartedAt: '2026-02-15T00:00:00.000Z',
      lastInitializationSucceededAt: '2026-02-15T00:00:01.000Z',
      lastInitializationFailure: null,
      runtimeCorruptionRecoveryCount: 0,
      lastRuntimeCorruptionAt: null,
      lastRuntimeCorruptionContext: null,
    });
  });

  it('db:test success path', async () => {
    const handler = handlers.get('db:test');
    const row = { test: 1, timestamp: 'now' };
    mockDb.query.mockResolvedValue({ rows: [row] });

    const result = await handler?.({} as unknown);

    expect(mockDb.query).toHaveBeenCalledWith('SELECT 1');
    expect(result).toEqual({
      success: true,
      message: 'Database connection successful',
      dbLocation: 'Main Process',
    });
  });

  it('db:test failure path', async () => {
    const handler = handlers.get('db:test');
    mockDb.query.mockRejectedValue(new Error('oops'));

    const result = await handler?.({} as unknown);

    expect(result).toEqual({
      success: false,
      message: 'Database connection failed: oops',
      dbLocation: 'Main Process',
    });
  });

  describe('db:clearAll handler', () => {
    it('requires confirmation token', async () => {
      const handler = handlers.get('db:clearAll');

      const result = await handler?.({} as unknown);

      expect(result).toEqual({
        success: false,
        message: 'Unauthorized: Invalid or missing confirmation token',
        deletedFiles: 0,
        deletedChunks: 0,
      });
      expect(getDatabaseMock).not.toHaveBeenCalled();
    });

    it('rejects invalid confirmation token', async () => {
      const handler = handlers.get('db:clearAll');

      const result = await handler?.({} as unknown, 'invalid_token');

      expect(result).toEqual({
        success: false,
        message: 'Unauthorized: Invalid or missing confirmation token',
        deletedFiles: 0,
        deletedChunks: 0,
      });
      expect(getDatabaseMock).not.toHaveBeenCalled();
    });

    it('successfully clears database with valid token', async () => {
      const handler = handlers.get('db:clearAll');

      // Mock transaction to call the callback immediately
      mockDb.transaction.mockImplementation(async (callback) => {
        const mockTx = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ count: '5' }] }) // chunks count
            .mockResolvedValueOnce({ rows: [{ count: '3' }] }) // files count
            .mockResolvedValueOnce(undefined) // DELETE chunks
            .mockResolvedValueOnce(undefined), // DELETE files
        };
        return await callback(mockTx);
      });

      const result = await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE');

      expect(getDatabaseMock).toHaveBeenCalled();
      expect(mockDb.transaction).toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        message: 'Database cleared successfully',
        deletedFiles: 3,
        deletedChunks: 5,
      });
    });

    it('handles database errors gracefully', async () => {
      const handler = handlers.get('db:clearAll');

      mockDb.transaction.mockRejectedValue(new Error('Database connection failed'));

      const result = await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        success: false,
        message: 'Database clear failed: Database connection failed',
        deletedFiles: 0,
        deletedChunks: 0,
      });
    });

    it('handles transaction callback errors', async () => {
      const handler = handlers.get('db:clearAll');

      mockDb.transaction.mockImplementation(async (callback) => {
        const mockTx = {
          query: vi.fn().mockRejectedValue(new Error('Query failed')),
        };
        return await callback(mockTx);
      });

      const result = await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        success: false,
        message: 'Database clear failed: Query failed',
        deletedFiles: 0,
        deletedChunks: 0,
      });
    });

    it('ignores missing relation errors when clearing selection snapshots', async () => {
      const handler = handlers.get('db:clearAll');

      mockDb.transaction.mockImplementation(async (callback) => {
        const error = Object.assign(
          new Error('relation "selection_snapshot_files" does not exist'),
          { code: '42P01' }
        );
        const mockTx = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // chunks count
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // files count
            .mockResolvedValueOnce(undefined) // DELETE chunks
            .mockRejectedValueOnce(error) // DELETE snapshot files
            .mockResolvedValueOnce(undefined) // DELETE files
            .mockResolvedValueOnce(undefined) // DELETE embedding_sets
            .mockResolvedValueOnce(undefined), // DELETE job_queue
        };
        return await callback(mockTx);
      });

      const result = await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        success: true,
        message: 'Database cleared successfully',
        deletedFiles: 0,
        deletedChunks: 0,
      });
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('logs unexpected errors when clearing selection snapshots', async () => {
      const handler = handlers.get('db:clearAll');

      mockDb.transaction.mockImplementation(async (callback) => {
        const mockTx = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // chunks count
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // files count
            .mockResolvedValueOnce(undefined) // DELETE chunks
            .mockRejectedValueOnce(new Error('boom')) // DELETE snapshot files
            .mockResolvedValueOnce(undefined) // DELETE files
            .mockResolvedValueOnce(undefined) // DELETE embedding_sets
            .mockResolvedValueOnce(undefined), // DELETE job_queue
        };
        return await callback(mockTx);
      });

      const result = await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE');

      expect(result).toEqual({
        success: true,
        message: 'Database cleared successfully',
        deletedFiles: 0,
        deletedChunks: 0,
      });
      expect(loggerWarn).toHaveBeenCalledWith('Failed to clear selection snapshots', {
        error: expect.any(Error),
      });
    });
  });

  describe('live query backgrounding', () => {
    // NOTE: flushPendingLiveUpdates uses require('electron').BrowserWindow.getAllWindows()
    // which doesn't resolve through the vi.mock factory. These tests focus on the
    // pause/resume subscription lifecycle. The flush path is covered by the module
    // being exercised in integration.

    function createLiveQuerySender(id: number): {
      id: number;
      isDestroyed: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
    } {
      return {
        id,
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
        once: vi.fn(),
      };
    }

    async function setupLiveQuery(sender = createLiveQuerySender(50)) {
      const handler = handlers.get('db:live-query:start');
      if (!handler) {
        throw new Error('handler not registered');
      }

      let listener: ((results: unknown) => void) | null = null;
      const liveHandle = {
        initialResults: { rows: [] },
        subscribe: vi.fn((cb: (results: unknown) => void) => {
          listener = cb;
        }),
        unsubscribe: vi.fn(),
        refresh: vi.fn(),
      };
      mockDb.live.query.mockResolvedValue(liveHandle);

      const result = (await handler({ sender } as unknown, {
        query: 'SELECT 1',
      })) as { id: number };
      return { result, listener: listener!, sender, liveHandle };
    }

    it('pauses subscriptions on background and resumes on foreground', async () => {
      const { setBackgrounded } = await import('../../ipc-handlers');
      const { liveHandle } = await setupLiveQuery();

      // subscribe called once during setup
      expect(liveHandle.subscribe).toHaveBeenCalledTimes(1);

      // Enter backgrounded state — should unsubscribe
      setBackgrounded(true);
      expect(liveHandle.unsubscribe).toHaveBeenCalled();

      // Return to foreground — should re-subscribe
      // pendingLiveUpdates is empty so flushPendingLiveUpdates is a no-op
      setBackgrounded(false);
      expect(liveHandle.subscribe).toHaveBeenCalledTimes(2);
    });

    it('does not pause when setBackgrounded(false) is called while already foregrounded', async () => {
      const { setBackgrounded } = await import('../../ipc-handlers');
      const { liveHandle } = await setupLiveQuery();

      // Already foregrounded — setting false again should not re-subscribe
      setBackgrounded(false);
      expect(liveHandle.subscribe).toHaveBeenCalledTimes(1); // only initial
      expect(liveHandle.unsubscribe).not.toHaveBeenCalled();
    });

    it('does not re-pause when setBackgrounded(true) is called while already backgrounded', async () => {
      const { setBackgrounded } = await import('../../ipc-handlers');
      const { liveHandle } = await setupLiveQuery();

      setBackgrounded(true);
      expect(liveHandle.unsubscribe).toHaveBeenCalledTimes(1);

      // Already backgrounded — should not unsubscribe again
      setBackgrounded(true);
      expect(liveHandle.unsubscribe).toHaveBeenCalledTimes(1);

      // Clean up without triggering flush (no pending updates)
      setBackgrounded(false);
    });

    it('cleans up subscriptions when a backgrounded owner window is no longer available', async () => {
      const { setBackgrounded } = await import('../../ipc-handlers');
      const { listener, liveHandle, sender } = await setupLiveQuery();
      const getAllWindowsMock = vi.mocked(BrowserWindow.getAllWindows);

      setBackgrounded(true);
      listener({ rows: [{ id: 99 }] });

      getAllWindowsMock.mockReturnValue([]);

      setBackgrounded(false);
      await Promise.resolve();

      expect(liveHandle.unsubscribe).toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('cleans up subscriptions when foreground sends fail because the render frame was disposed', async () => {
      const { flushPendingLiveUpdates } = await import('../../ipc-handlers');
      const { listener, liveHandle, sender } = await setupLiveQuery();
      const getAllWindowsMock = vi.mocked(BrowserWindow.getAllWindows);

      sender.send.mockImplementation(() => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      });
      getAllWindowsMock.mockReturnValue([createWindowWithWebContents(sender)]);

      listener({ rows: [{ id: 123 }] });
      // Flush the batched update to trigger the disposed-frame error path
      flushPendingLiveUpdates();
      await Promise.resolve();

      expect(liveHandle.unsubscribe).toHaveBeenCalled();
    });

    it('does not retry disposed-frame sends while owner cleanup is still in flight', async () => {
      const { flushPendingLiveUpdates } = await import('../../ipc-handlers');
      const { listener, liveHandle, sender } = await setupLiveQuery();
      const getAllWindowsMock = vi.mocked(BrowserWindow.getAllWindows);

      let resolveCleanup: (() => void) | null = null;
      const cleanupInFlight = new Promise<void>((resolve) => {
        resolveCleanup = resolve;
      });
      liveHandle.unsubscribe.mockReturnValue(cleanupInFlight);
      sender.send.mockImplementation(() => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      });
      getAllWindowsMock.mockReturnValue([createWindowWithWebContents(sender)]);

      listener({ rows: [{ id: 1 }] });
      flushPendingLiveUpdates();

      listener({ rows: [{ id: 2 }] });
      flushPendingLiveUpdates();

      expect(sender.send).toHaveBeenCalledTimes(1);

      resolveCleanup?.();
      await cleanupInFlight;
      await Promise.resolve();
    });

    it('logs unexpected send errors and continues flushing healthy subscriptions', async () => {
      const { flushPendingLiveUpdates } = await import('../../ipc-handlers');
      const failingSender = createLiveQuerySender(60);
      const healthySender = createLiveQuerySender(61);
      const failingSubscription = await setupLiveQuery(failingSender);
      const healthySubscription = await setupLiveQuery(healthySender);
      const getAllWindowsMock = vi.mocked(BrowserWindow.getAllWindows);

      failingSender.send.mockImplementation(() => {
        throw new Error('boom');
      });
      getAllWindowsMock.mockReturnValue([
        createWindowWithWebContents(failingSender),
        createWindowWithWebContents(healthySender),
      ]);

      failingSubscription.listener({ rows: [{ id: 456 }] });
      healthySubscription.listener({ rows: [{ id: 789 }] });

      expect(() => flushPendingLiveUpdates()).not.toThrow();
      expect(failingSender.send).toHaveBeenCalledTimes(1);
      expect(healthySender.send).toHaveBeenCalledWith('db:live-query:update', {
        id: healthySubscription.result.id,
        results: { rows: [{ id: 789 }] },
      });
      expect(loggerWarn).toHaveBeenCalledWith('Failed to deliver live query update to renderer', {
        subscriptionId: failingSubscription.result.id,
        webContentsId: failingSender.id,
        error: expect.any(Error),
      });

      healthySubscription.sender.send.mockClear();
      healthySubscription.listener({ rows: [{ id: 790 }] });
      flushPendingLiveUpdates();

      expect(healthySender.send).toHaveBeenCalledWith('db:live-query:update', {
        id: healthySubscription.result.id,
        results: { rows: [{ id: 790 }] },
      });
    });

    it('keeps owner destroy-listener registration when disposed-frame cleanup runs before webContents destruction', async () => {
      const { flushPendingLiveUpdates } = await import('../../ipc-handlers');
      const handler = handlers.get('db:live-query:start');
      if (!handler) {
        throw new Error('handler not registered');
      }

      const firstLiveHandle = {
        initialResults: { rows: [] },
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        refresh: vi.fn(),
      };
      const secondLiveHandle = {
        initialResults: { rows: [] },
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        refresh: vi.fn(),
      };
      mockDb.live.query
        .mockResolvedValueOnce(firstLiveHandle)
        .mockResolvedValueOnce(secondLiveHandle);

      const sender = {
        id: 51,
        isDestroyed: vi.fn(() => false),
        send: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error('Render frame was disposed before WebFrameMain could be accessed');
          })
          .mockImplementation(() => undefined),
        once: vi.fn(),
      };
      const getAllWindowsMock = vi.mocked(BrowserWindow.getAllWindows);
      getAllWindowsMock.mockReturnValue([createWindowWithWebContents(sender)]);

      const firstResult = (await handler({ sender } as unknown, {
        query: 'SELECT 1',
      })) as { id: number };
      const firstListener = firstLiveHandle.subscribe.mock.calls[0]?.[0] as
        | ((results: unknown) => void)
        | undefined;
      if (!firstListener) {
        throw new Error('expected first live-query listener');
      }

      firstListener({ rows: [{ id: 1 }] });
      // Flush the batched update to trigger the disposed-frame error path
      flushPendingLiveUpdates();
      await Promise.resolve();

      expect(firstLiveHandle.unsubscribe).toHaveBeenCalled();
      expect(sender.once).toHaveBeenCalledTimes(1);

      const secondResult = (await handler({ sender } as unknown, {
        query: 'SELECT 2',
      })) as { id: number };

      expect(secondResult.id).not.toBe(firstResult.id);
      expect(secondLiveHandle.subscribe).toHaveBeenCalledTimes(1);
      expect(sender.once).toHaveBeenCalledTimes(1);
    });
  });
});
