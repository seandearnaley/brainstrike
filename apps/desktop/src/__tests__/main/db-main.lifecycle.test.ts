import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const rmSyncMock = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  rmSync: rmSyncMock,
  default: { existsSync: existsSyncMock, mkdirSync: mkdirSyncMock, rmSync: rmSyncMock },
}));

const appGetPathMock = vi.fn(() => '/mock/documents');
vi.mock('electron', () => ({ app: { getPath: appGetPathMock } }));

const migrateMock = vi.fn();
const closeMock = vi.fn(async () => {});
const queryMock = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }));
const execMock = vi.fn(async () => {});
const PGliteMock = vi.fn().mockImplementation(function (this: {
  close: () => Promise<void>;
  query: () => Promise<unknown>;
  exec: () => Promise<void>;
}) {
  this.close = closeMock;
  this.query = queryMock;
  this.exec = execMock;
});
vi.mock('@electric-sql/pglite', () => ({ PGlite: PGliteMock }));
vi.mock('@electric-sql/pglite/vector', () => ({ vector: { name: 'vector' } }));
vi.mock('@brainstrike/db', () => ({ migrate: (...args: unknown[]) => migrateMock(...args) }));

vi.mock('@brainstrike/utils', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils')>('@brainstrike/utils');
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

describe('db-main lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env['NODE_ENV'] = 'test';
    existsSyncMock.mockReturnValue(true);
  });

  it('closeDatabase closes handle and resets singleton', async () => {
    const { initializeMainDatabase, getDatabase, closeDatabase } = await import('../../db-main');
    await initializeMainDatabase();
    const before = await getDatabase();
    await closeDatabase();
    // Re-initialize should allocate a new instance
    const after = await initializeMainDatabase();
    expect(after).not.toBe(before);
    expect(closeMock).toHaveBeenCalled();
  });

  it('reinitializeDatabase closes and recreates', async () => {
    const { initializeMainDatabase, reinitializeDatabase } = await import('../../db-main');
    const first = await initializeMainDatabase();
    const second = await reinitializeDatabase();
    expect(second).not.toBe(first);
    expect(closeMock).toHaveBeenCalled();
  });

  it('throws with helpful message when migrations fail', async () => {
    const { initializeMainDatabase } = await import('../../db-main');
    migrateMock.mockRejectedValueOnce(new Error('boom'));
    await expect(initializeMainDatabase()).rejects.toThrow(/migrations failed/i);
  });

  it('computes production data dir when NODE_ENV=production', async () => {
    process.env['NODE_ENV'] = 'production';
    const { initializeMainDatabase } = await import('../../db-main');
    // Force create case to exercise mkdir path and dataDir computation
    existsSyncMock.mockReturnValueOnce(false);
    await initializeMainDatabase();
    const expectedPath = path.join('/mock/documents', 'BrainStrike', 'pgdata');
    expect(mkdirSyncMock).not.toHaveBeenCalledWith(expect.not.stringContaining('BrainStrike-dev'));
    expect(mkdirSyncMock).toHaveBeenCalledWith(expectedPath, { recursive: true });
  });
});
