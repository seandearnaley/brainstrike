import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const rmSyncMock = vi.fn();
const cpSyncMock = vi.fn();
const openSyncMock = vi.fn(() => 123);
const writeFileSyncMock = vi.fn();
const closeSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const readFileSyncMock = vi.fn(() => '');
const lstatSyncMock = vi.fn(() => ({
  isDirectory: () => false,
  isFile: () => false,
}));
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  rmSync: rmSyncMock,
  cpSync: cpSyncMock,
  openSync: openSyncMock,
  writeFileSync: writeFileSyncMock,
  closeSync: closeSyncMock,
  unlinkSync: unlinkSyncMock,
  readFileSync: readFileSyncMock,
  lstatSync: lstatSyncMock,
  default: {
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    rmSync: rmSyncMock,
    cpSync: cpSyncMock,
    openSync: openSyncMock,
    writeFileSync: writeFileSyncMock,
    closeSync: closeSyncMock,
    unlinkSync: unlinkSyncMock,
    readFileSync: readFileSyncMock,
    lstatSync: lstatSyncMock,
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
    process.env['BRAINSTRIKE_DB_PROFILE'] = '';
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
    existsSyncMock.mockImplementation(() => false);
    const { initializeMainDatabase } = await import('../../db-main');
    await initializeMainDatabase();
    const expectedPath = path.join(
      '/mock/documents',
      'BrainStrike',
      'profiles',
      'default',
      'pgdata'
    );
    expect(mkdirSyncMock).not.toHaveBeenCalledWith(expect.not.stringContaining('BrainStrike-dev'));
    expect(mkdirSyncMock).toHaveBeenCalledWith(expectedPath, { recursive: true });
  });

  it('uses profile-scoped data directory in development mode', async () => {
    process.env['NODE_ENV'] = 'development';
    process.env['BRAINSTRIKE_DB_PROFILE'] = 'feature-branch';
    existsSyncMock.mockImplementation(() => false);

    const { initializeMainDatabase, getDatabaseDiagnostics } = await import('../../db-main');
    await initializeMainDatabase();

    const diagnostics = getDatabaseDiagnostics();
    expect(diagnostics.databaseProfile).toBe('feature-branch');
    expect(diagnostics.dataDir).toBe(
      path.join('/mock/documents', 'BrainStrike-dev', 'profiles', 'feature-branch', 'pgdata')
    );
  });

  it('fails fast with concurrency category when lock is held by another process', async () => {
    const lockError = new Error('lock exists') as Error & { code: string };
    lockError.code = 'EEXIST';
    openSyncMock.mockImplementationOnce(() => {
      throw lockError;
    });
    readFileSyncMock.mockReturnValueOnce('424242');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => undefined);

    try {
      const { initializeMainDatabase, getDatabaseDiagnostics } = await import('../../db-main');
      await expect(initializeMainDatabase()).rejects.toThrow(/Database lock is held by process/);
      const diagnostics = getDatabaseDiagnostics();
      expect(diagnostics.lastInitializationFailure?.category).toBe('concurrency');
      expect(diagnostics.lastInitializationFailure?.stage).toBe('open-database');
    } finally {
      killSpy.mockRestore();
    }
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
    process.env['BRAINSTRIKE_DB_PROFILE'] = 'test-profile';
    vi.resetModules();

    const { resetLocalDatabase } = await import('../../db-main');
    await resetLocalDatabase();

    // Should delete only the active profile directory.
    const expectedAppDataPath = path.join(
      '/mock/documents',
      'BrainStrike-dev',
      'profiles',
      'test-profile'
    );
    expect(cpSyncMock).toHaveBeenCalledWith(
      expectedAppDataPath,
      expect.stringContaining(
        path.join('/mock/documents', 'BrainStrike-dev', 'backups', 'test-profile-')
      ),
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
