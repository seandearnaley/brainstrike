import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  };
});

vi.mock('electron', async () => {
  const electronUtils = await import('@brainstrike/test-utils');
  const typedIpcMain = electronUtils.createIpcMainMock();
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

vi.mock('@brainstrike/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils')>();
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
vi.mock('@brainstrike/file-system', () => {
  const MockAdapter = vi.fn();
  MockAdapter.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {});
  });
  return {
    ElectronFileSystemAdapter: MockAdapter,
    createFixtureCapableAdapter: (adapter: unknown) => adapter,
  };
});

vi.mock('@brainstrike/storage', () => {
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

    async function setupLiveQuery() {
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

      const sender = {
        id: 50,
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
        once: vi.fn(),
      };

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
  });
});
