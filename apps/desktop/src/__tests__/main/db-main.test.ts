import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  default: { existsSync: existsSyncMock, mkdirSync: mkdirSyncMock },
}));

const appGetPathMock = vi.fn(() => '/mock/documents');
vi.mock('electron', () => ({ app: { getPath: appGetPathMock } }));

const migrateMock = vi.fn();
const closeMock = vi.fn();
const PGliteMock = vi.fn(function (this: { close: () => void }) {
  this.close = closeMock;
});
const NodeFSMock = vi.fn();
vi.mock('@electric-sql/pglite', () => ({ PGlite: PGliteMock }));
vi.mock('@electric-sql/pglite/nodefs', () => ({ NodeFS: NodeFSMock }));
vi.mock('@brainstrike/db', () => ({ migrate: migrateMock }));

vi.mock('@brainstrike/utils', () => ({ createLogger: () => ({ info: vi.fn() }) }));

describe('initializeMainDatabase', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // biome-ignore lint/complexity/useLiteralKeys: index signature requires bracket notation
    process.env['NODE_ENV'] = 'test';
  });

  it('creates directory, migrates, and returns singleton instance', async () => {
    existsSyncMock.mockReturnValue(false);

    const { initializeMainDatabase } = await import('../../db-main');
    const db1 = await initializeMainDatabase();
    const expectedPath = path.join('/mock/documents', 'BrainStrike-dev', 'pgdata');
    const fsInstance = NodeFSMock.mock.instances[0];

    expect(appGetPathMock).toHaveBeenCalledWith('documents');
    expect(NodeFSMock).toHaveBeenCalledWith(expectedPath);
    expect(mkdirSyncMock).toHaveBeenCalledWith(expectedPath, { recursive: true });
    expect(PGliteMock).toHaveBeenCalledTimes(1);
    const firstCall = PGliteMock.mock.calls[0] as [Record<string, unknown>] | undefined;
    // biome-ignore lint/complexity/useLiteralKeys: index signature requires bracket notation
    expect(firstCall?.[0]['fs']).toBe(fsInstance);
    expect(migrateMock).toHaveBeenCalledWith(db1);

    const db2 = await initializeMainDatabase();
    expect(db1).toBe(db2);
    expect(PGliteMock).toHaveBeenCalledTimes(1);
    expect(migrateMock).toHaveBeenCalledTimes(1);
  });

  it('getDatabase throws before initialization and returns instance after', async () => {
    const { getDatabase, initializeMainDatabase } = await import('../../db-main');

    expect(() => getDatabase()).toThrowError('Database not initialized');

    existsSyncMock.mockReturnValue(true);
    const db = await initializeMainDatabase();
    expect(getDatabase()).toBe(db);
  });
});
