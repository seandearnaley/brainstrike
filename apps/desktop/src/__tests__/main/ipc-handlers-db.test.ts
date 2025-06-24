import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, mockIpcMain, mockDb, getDatabaseMock, mockApp } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockIpcMain = {
    handle: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(channel, listener);
    }),
  };

  const mockDb = {
    query: vi.fn(),
    exec: vi.fn(),
  };

  const getDatabaseMock = vi.fn(() => mockDb);

  const mockApp = {
    getPath: vi.fn(() => '/mock/documents'),
    whenReady: vi.fn(() => new Promise<void>(() => {})),
    isPackaged: false,
    on: vi.fn(),
  };

  return { handlers, mockIpcMain, mockDb, getDatabaseMock, mockApp };
});

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  app: mockApp,
  BrowserWindow: vi.fn(),
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
}));

vi.mock('../../db-main', () => ({ getDatabase: getDatabaseMock }));

vi.mock('@brainstrike/file-system', () => ({
  ElectronFileSystemAdapter: vi.fn(() => ({})),
}));

vi.mock('@brainstrike/storage', () => ({
  ElectronStorageAdapter: vi.fn(() => ({})),
}));

vi.mock('electron-store', () => ({
  default: vi.fn(() => ({})),
}));

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

    const dbPath = path.join('/mock/documents', 'BrainStrike-dev', 'pgdata');
    expect(mockDb.query).toHaveBeenCalledWith('SELECT 1 as test, current_timestamp as timestamp');
    expect(result).toEqual({
      success: true,
      message: `Database connected successfully. Test query returned: ${JSON.stringify(row)}`,
      dbLocation: `NodeFS: ${dbPath}`,
    });
  });

  it('db:test failure path', async () => {
    const handler = handlers.get('db:test');
    mockDb.query.mockRejectedValue(new Error('oops'));

    const result = await handler?.({} as unknown);

    expect(result).toEqual({
      success: false,
      message: 'Database test failed: Error: oops',
      dbLocation: 'Unknown',
    });
  });
});
