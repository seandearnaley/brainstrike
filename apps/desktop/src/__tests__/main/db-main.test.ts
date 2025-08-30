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
const queryMock = vi.fn();
const PGliteMock = vi.fn(function (this: { close: () => void; query: () => void }) {
  this.close = closeMock;
  this.query = queryMock;
});
vi.mock('@electric-sql/pglite', () => ({ PGlite: PGliteMock }));
vi.mock('@brainstrike/db', () => ({ migrate: migrateMock }));

vi.mock('@brainstrike/utils', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('initializeMainDatabase', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env['NODE_ENV'] = 'test';
  });

  it('creates directory, migrates, and returns singleton instance', async () => {
    existsSyncMock.mockReturnValue(false);

    const { initializeMainDatabase } = await import('../../db-main');
    const db1 = await initializeMainDatabase();
    const expectedPath = path.join('/mock/documents', 'BrainStrike-dev', 'pgdata');

    expect(appGetPathMock).toHaveBeenCalledWith('documents');
    expect(mkdirSyncMock).toHaveBeenCalledWith(expectedPath, { recursive: true });
    expect(PGliteMock).toHaveBeenCalledTimes(1);
    // Verify PGlite was called with dataDir (vector extension will fail to load in test environment)
    expect(PGliteMock).toHaveBeenCalledWith({
      dataDir: expectedPath,
    });
    expect(migrateMock).toHaveBeenCalledWith(db1);

    const db2 = await initializeMainDatabase();
    expect(db1).toBe(db2);
    expect(PGliteMock).toHaveBeenCalledTimes(1);
    expect(migrateMock).toHaveBeenCalledTimes(1);
  });

  it('getDatabase auto-initializes when called (lazy loading)', async () => {
    const { getDatabase } = await import('../../db-main');

    existsSyncMock.mockReturnValue(true);

    // getDatabase now auto-initializes when called
    const db = await getDatabase();
    expect(db).toBeDefined();
    expect(PGliteMock).toHaveBeenCalled();
    expect(migrateMock).toHaveBeenCalled();

    // Subsequent calls return the same instance
    const db2 = await getDatabase();
    expect(db2).toBe(db);
  });
});
