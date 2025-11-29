import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist Electron and db mocks safely
const { handlers, mockDb, getDatabaseMock } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockDb = { query: vi.fn(), exec: vi.fn(), transaction: vi.fn() };
  const getDatabaseMock = vi.fn(() => mockDb);
  return { handlers, mockDb, getDatabaseMock };
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
  return {
    ipcMain: typedIpcMain,
    app,
    BrowserWindow: vi.fn(),
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
    Menu: {
      setApplicationMenu: vi.fn(),
      buildFromTemplate: vi.fn(),
    },
  };
});

vi.mock('../../db-main', () => ({
  getDatabase: getDatabaseMock,
  isCorruptionError: vi.fn(() => false),
  handleRuntimeCorruption: vi.fn(),
}));

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
  });
});
