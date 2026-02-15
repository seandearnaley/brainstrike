import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const rmSyncMock = vi.fn();
const cpSyncMock = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  rmSync: rmSyncMock,
  cpSync: cpSyncMock,
  default: {
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    rmSync: rmSyncMock,
    cpSync: cpSyncMock,
  },
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

  it('auto-recovers from database corruption during initialization', async () => {
    const corruptionError = new Error("right sibling's left-link doesn't match") as Error & {
      code: string;
    };
    corruptionError.code = 'XX002';

    // First call throws corruption error, second succeeds
    // Use function syntax for Vitest 4 constructor mocks (need this reference to prevent arrow conversion)
    PGliteMock.mockImplementationOnce(function (this: Record<string, unknown>) {
      Object.assign(this, {}); // Reference this to keep function syntax
      throw corruptionError;
    });

    const { initializeMainDatabase } = await import('../../db-main');
    const db = await initializeMainDatabase();

    // Should have attempted reset (rmSync called) and succeeded on retry
    expect(rmSyncMock).toHaveBeenCalled();
    expect(db).toBeDefined();
  });

  it('auto-recovers from database corruption during migration', async () => {
    const corruptionError = new Error('could not locate a valid checkpoint record') as Error & {
      code: string;
    };
    corruptionError.code = 'XX002';

    // First migration throws corruption, second succeeds
    migrateMock.mockRejectedValueOnce(corruptionError);

    const { initializeMainDatabase } = await import('../../db-main');
    const db = await initializeMainDatabase();

    // Should have attempted reset and succeeded on retry
    expect(rmSyncMock).toHaveBeenCalled();
    expect(db).toBeDefined();
  });

  it('auto-recovers from wasm abort during initialization', async () => {
    const wasmAbort = new Error('Aborted(). Build with -sASSERTIONS for more info.');

    PGliteMock.mockImplementationOnce(function (this: Record<string, unknown>) {
      Object.assign(this, {});
      throw wasmAbort;
    });

    const { initializeMainDatabase } = await import('../../db-main');
    const db = await initializeMainDatabase();

    expect(rmSyncMock).toHaveBeenCalled();
    expect(db).toBeDefined();
  });

  it('throws if auto-recovery fails', async () => {
    const corruptionError = new Error("right sibling's left-link doesn't match") as Error & {
      code: string;
    };
    corruptionError.code = 'XX002';

    // Both attempts fail with corruption
    // Use function syntax for Vitest 4 constructor mocks (need this reference to prevent arrow conversion)
    PGliteMock.mockImplementation(function (this: Record<string, unknown>) {
      Object.assign(this, {}); // Reference this to keep function syntax
      throw corruptionError;
    });

    const { initializeMainDatabase } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(/auto-recovery failed/i);
  });

  it('resetLocalDatabase deletes parent app data directory', async () => {
    process.env['NODE_ENV'] = 'development';
    vi.resetModules();

    const { resetLocalDatabase } = await import('../../db-main');
    await resetLocalDatabase();

    // Should delete the parent BrainStrike-dev folder, not just pgdata
    const expectedAppDataPath = path.join('/mock/documents', 'BrainStrike-dev');
    expect(cpSyncMock).toHaveBeenCalledWith(
      expectedAppDataPath,
      expect.stringContaining(path.join('/mock/documents', 'backups', 'BrainStrike-dev-')),
      { recursive: true, errorOnExist: true, force: false }
    );
    expect(rmSyncMock).toHaveBeenCalledWith(expectedAppDataPath, { recursive: true, force: true });
  });

  it('tracks runtime corruption recovery in diagnostics', async () => {
    // Ensure we reset any prior constructor override from previous tests
    PGliteMock.mockImplementation(function (this: {
      close: () => Promise<void>;
      query: () => Promise<unknown>;
      exec: () => Promise<void>;
    }) {
      this.close = closeMock;
      this.query = queryMock;
      this.exec = execMock;
    });

    const { handleRuntimeCorruption, getDatabaseDiagnostics } = await import('../../db-main');

    await handleRuntimeCorruption('db:query');

    const diagnostics = getDatabaseDiagnostics();
    expect(diagnostics.runtimeCorruptionRecoveryCount).toBe(1);
    expect(diagnostics.lastRuntimeCorruptionContext).toBe('db:query');
    expect(diagnostics.lastRuntimeCorruptionAt).not.toBeNull();
  });
});
