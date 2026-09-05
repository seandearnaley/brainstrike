import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');
const originalDbRootPath = process.env['BRAINSTRIKE_DB_ROOT_PATH'];
const originalSerializePgliteInit = process.env['BRAINSTRIKE_SERIALIZE_PGLITE_INIT'];

function installUtilityProcessParentPort(): void {
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: {
      on: vi.fn(),
      postMessage: vi.fn(),
    },
    writable: true,
  });
}

function restoreParentPort(): void {
  if (originalParentPortDescriptor) {
    Object.defineProperty(process, 'parentPort', originalParentPortDescriptor);
    return;
  }

  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: undefined,
    writable: true,
  });
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

function getPGliteInitializationLockWritePath(): string {
  const lockWriteCall = writeFileSyncMock.mock.calls.find(
    ([candidatePath]) =>
      typeof candidatePath === 'string' &&
      candidatePath.includes('brainstrike-pglite-initialization-')
  );

  expect(lockWriteCall).toBeDefined();
  const [lockPath] = lockWriteCall ?? [];
  expect(typeof lockPath).toBe('string');
  return lockPath as string;
}

const existsSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const rmSyncMock = vi.fn();
const renameSyncMock = vi.fn();
const cpSyncMock = vi.fn();
const openSyncMock = vi.fn(() => 123);
const writeFileSyncMock = vi.fn();
const closeSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const utimesSyncMock = vi.fn();
const statSyncMock = vi.fn(() => ({ mtimeMs: Date.now() }));
const readFileSyncMock = vi.fn((_candidate: string) => '');
const readdirSyncMock = vi.fn((_path?: string, _options?: unknown): unknown[] => []);
const lstatSyncMock = vi.fn(
  (_candidate: string): { isDirectory: () => boolean; isFile: () => boolean } => ({
    isDirectory: () => false,
    isFile: () => false,
  })
);
vi.mock('node:fs', () => ({
  closeSync: closeSyncMock,
  cpSync: cpSyncMock,
  default: {
    closeSync: closeSyncMock,
    cpSync: cpSyncMock,
    existsSync: existsSyncMock,
    lstatSync: lstatSyncMock,
    mkdirSync: mkdirSyncMock,
    openSync: openSyncMock,
    readdirSync: readdirSyncMock,
    readFileSync: readFileSyncMock,
    renameSync: renameSyncMock,
    rmSync: rmSyncMock,
    statSync: statSyncMock,
    unlinkSync: unlinkSyncMock,
    utimesSync: utimesSyncMock,
    writeFileSync: writeFileSyncMock,
  },
  existsSync: existsSyncMock,
  lstatSync: lstatSyncMock,
  mkdirSync: mkdirSyncMock,
  openSync: openSyncMock,
  readdirSync: readdirSyncMock,
  readFileSync: readFileSyncMock,
  renameSync: renameSyncMock,
  rmSync: rmSyncMock,
  statSync: statSyncMock,
  unlinkSync: unlinkSyncMock,
  utimesSync: utimesSyncMock,
  writeFileSync: writeFileSyncMock,
}));

const appGetPathMock = vi.fn(() => '/mock/documents');
vi.mock('electron', () => ({ app: { getPath: appGetPathMock } }));

const migrateMock = vi.fn();
const closeMock = vi.fn(async () => {});
const queryMock = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }));
const execMock = vi.fn(async () => {});
const syncToFsMock = vi.fn(async () => {});
const PGliteMock = vi.fn().mockImplementation(function (this: {
  close: () => Promise<void>;
  query: () => Promise<unknown>;
  exec: () => Promise<void>;
  syncToFs: () => Promise<void>;
}) {
  this.close = closeMock;
  this.query = queryMock;
  this.exec = execMock;
  this.syncToFs = syncToFsMock;
});
vi.mock('@electric-sql/pglite', () => ({
  PGlite: { create: (options: unknown) => Promise.resolve(new PGliteMock(options)) },
}));
vi.mock('@electric-sql/pglite-pgvector', () => ({ vector: { name: 'vector' } }));
vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  migrate: (...args: unknown[]) => migrateMock(...args),
}));
vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  migrate: (...args: unknown[]) => migrateMock(...args),
}));

vi.mock('@brainstrike/logging', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/logging')>('@brainstrike/logging');
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

describe('db-main lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installUtilityProcessParentPort();
    process.env['NODE_ENV'] = 'test';
    process.env['BRAINSTRIKE_DB_PROFILE'] = '';
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_DB_ROOT_PATH');
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_SERIALIZE_PGLITE_INIT');
    existsSyncMock.mockReturnValue(true);
    // clearAllMocks() resets call history but NOT implementations, so without this
    // a per-test override (a PG_VERSION major, a thrown utimes, an enumerated
    // backup) would leak into later tests. Restore defaults so each test starts
    // from a clean slate.
    readFileSyncMock.mockImplementation(() => '');
    utimesSyncMock.mockImplementation(() => undefined);
    renameSyncMock.mockImplementation(() => undefined);
    cpSyncMock.mockImplementation(() => undefined);
    readdirSyncMock.mockReturnValue([]);
    statSyncMock.mockReturnValue({ mtimeMs: Date.now() });
  });

  afterEach(() => {
    restoreParentPort();
    restoreEnvValue('BRAINSTRIKE_DB_ROOT_PATH', originalDbRootPath);
    restoreEnvValue('BRAINSTRIKE_SERIALIZE_PGLITE_INIT', originalSerializePgliteInit);
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

  it('moves an incompatible (older Postgres major) data dir aside before initializing', async () => {
    // PG_VERSION reports an older engine major → the greenfield guard must move
    // the data dir aside (cheap rename, no cpSync) and start fresh.
    readFileSyncMock.mockImplementation((candidate: string) =>
      String(candidate).endsWith('PG_VERSION') ? '17' : ''
    );

    const { initializeMainDatabase } = await import('../../db-main');
    await initializeMainDatabase();

    // The old dir is renamed aside, not copied — proves no multi-GB cpSync.
    expect(renameSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('pgdata'),
      expect.stringContaining('.pre-pg18-from-pg17.bak')
    );
    expect(cpSyncMock).not.toHaveBeenCalled();
    // The backup's mtime is stamped to the move time (renameSync preserves the
    // OLD content mtime), so the retention clock starts now — not at the last DB
    // write — and this boot's prune can't immediately delete the fresh backup.
    expect(utimesSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('.pre-pg18-from-pg17.bak'),
      expect.any(Date),
      expect.any(Date)
    );
  });

  it('falls back to copy-aside (preserving a recoverable backup) when the rename fails', async () => {
    // rename can fail (lock/permission/ENOTEMPTY on the sibling). Rather than
    // silently wiping — degrading the .bak guarantee to permanent deletion — the
    // guard copies the dir aside so it stays recoverable, then removes the original.
    readFileSyncMock.mockImplementation((candidate: string) =>
      String(candidate).endsWith('PG_VERSION') ? '17' : ''
    );
    renameSyncMock.mockImplementation(() => {
      throw new Error('rename failed');
    });

    const { initializeMainDatabase } = await import('../../db-main');
    await initializeMainDatabase();

    // The dir is copied to the backup sibling and its mtime stamped.
    expect(cpSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/pgdata$/),
      expect.stringContaining('.pre-pg18-from-pg17.bak'),
      expect.objectContaining({ recursive: true })
    );
    expect(utimesSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('.pre-pg18-from-pg17.bak'),
      expect.any(Date),
      expect.any(Date)
    );
    // The original is removed only AFTER the copy succeeded.
    expect(rmSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/pgdata$/),
      expect.objectContaining({ recursive: true })
    );
  });

  it('wipes as a last resort only when both rename and copy-aside fail', async () => {
    readFileSyncMock.mockImplementation((candidate: string) =>
      String(candidate).endsWith('PG_VERSION') ? '17' : ''
    );
    renameSyncMock.mockImplementation(() => {
      throw new Error('rename failed');
    });
    cpSyncMock.mockImplementation(() => {
      throw new Error('copy failed');
    });

    const { initializeMainDatabase } = await import('../../db-main');
    await initializeMainDatabase();

    // No recoverable backup could be made → no mtime stamp, and the dir is wiped so
    // the app still boots greenfield on the unopenable PG17 dir.
    expect(utimesSyncMock).not.toHaveBeenCalled();
    expect(rmSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/pgdata$/),
      expect.objectContaining({ recursive: true })
    );
    // The partial/unstamped `.bak` left by the failed cpSync must ALSO be cleaned
    // up — and specifically AFTER cpSync (the pre-clear before cpSync can't remove a
    // partial the failed copy hadn't written yet), not left to linger ~14 days until
    // the retention prune reaps it.
    const cpOrder = cpSyncMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const bakCleanedAfterCopy = rmSyncMock.mock.calls.some(
      ([target], index) =>
        String(target).endsWith('.pre-pg18-from-pg17.bak') &&
        (rmSyncMock.mock.invocationCallOrder[index] ?? 0) > cpOrder
    );
    expect(bakCleanedAfterCopy).toBe(true);
  });

  it('does not let the same-boot prune delete the just-moved backup when the mtime stamp fails', async () => {
    // Edge case: utimesSync throws, so the moved-aside backup keeps the old DB's
    // (already-stale) content mtime. The unconditional same-boot prune must still
    // NOT delete it — the freshly-moved backup is excluded by path, independent of
    // mtime — otherwise the recovery window collapses to zero.
    readFileSyncMock.mockImplementation((candidate: string) =>
      String(candidate).endsWith('PG_VERSION') ? '17' : ''
    );
    utimesSyncMock.mockImplementation(() => {
      throw new Error('utimes failed');
    });
    // The prune enumerates the backup and sees a stale mtime (older than retention).
    const backupName = 'pgdata.pre-pg18-from-pg17.bak';
    readdirSyncMock.mockReturnValue([backupName]);
    statSyncMock.mockReturnValue({ mtimeMs: 0 });

    const { initializeMainDatabase } = await import('../../db-main');
    await initializeMainDatabase();

    // rmSync hits the backup path exactly once — the reconcile pre-clear — and the
    // prune does NOT remove it a second time (it was excluded).
    const backupRmCalls = rmSyncMock.mock.calls.filter(([target]) =>
      String(target).endsWith(backupName)
    );
    expect(backupRmCalls).toHaveLength(1);
  });

  it('does NOT move aside a matching (current Postgres major) data dir', async () => {
    readFileSyncMock.mockImplementation((candidate: string) =>
      String(candidate).endsWith('PG_VERSION') ? '18' : ''
    );

    const { initializeMainDatabase } = await import('../../db-main');
    await initializeMainDatabase();

    expect(renameSyncMock).not.toHaveBeenCalled();
  });

  it('fails loudly and leaves a NEWER-major data dir untouched (no downgrade)', async () => {
    // PG_VERSION reports a NEWER engine major (e.g. PG19 written by a later build,
    // then the user rolled back to this PG18 build). Downgrading the on-disk engine
    // is unsupported, but the newer data is still valid for a re-upgrade — so the
    // guard must NOT move it aside or wipe it. Init must fail loudly instead.
    readFileSyncMock.mockImplementation((candidate: string) =>
      String(candidate).endsWith('PG_VERSION') ? '19' : ''
    );

    const { initializeMainDatabase } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(/newer/i);

    // Crucially: the newer dir is preserved — neither moved aside nor wiped.
    expect(renameSyncMock).not.toHaveBeenCalled();
    expect(cpSyncMock).not.toHaveBeenCalled();
    const wipedDataDir = rmSyncMock.mock.calls.some(([target]) =>
      String(target).endsWith('pgdata')
    );
    expect(wipedDataDir).toBe(false);
  });

  it('closeDatabase still closes handle when syncToFs fails', async () => {
    const { initializeMainDatabase, closeDatabase } = await import('../../db-main');
    await initializeMainDatabase();
    syncToFsMock.mockRejectedValueOnce(new Error('sync failed'));
    await expect(closeDatabase()).resolves.toBeUndefined();
    expect(syncToFsMock).toHaveBeenCalled();
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

  it('derives a worktree-scoped profile when no explicit profile is set', async () => {
    process.env['NODE_ENV'] = 'development';
    process.env['BRAINSTRIKE_DB_PROFILE'] = '';

    const worktreeRoot = '/repo/worktrees/wt-a';
    const gitPointerPath = path.join(worktreeRoot, '.git');
    const resolvedGitDir = '/repo/main/.git/worktrees/wt-a';
    const gitHeadPath = path.join(resolvedGitDir, 'HEAD');
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(worktreeRoot);

    existsSyncMock.mockImplementation(
      (candidate: string) => candidate === gitPointerPath || candidate === gitHeadPath
    );
    lstatSyncMock.mockImplementation((candidate: string) => ({
      isDirectory: () => false,
      isFile: () => candidate === gitPointerPath,
    }));
    readFileSyncMock.mockImplementation((candidate: string) => {
      if (candidate === gitPointerPath) {
        return `gitdir: ${resolvedGitDir}`;
      }
      if (candidate === gitHeadPath) {
        return 'ref: refs/heads/feature/awesome';
      }
      return '';
    });

    try {
      const { initializeMainDatabase, getDatabaseDiagnostics } = await import('../../db-main');
      await initializeMainDatabase();

      const diagnostics = getDatabaseDiagnostics();
      expect(diagnostics.databaseProfile).toMatch(/^branch-feature-awesome-wt-[a-f0-9]{8}$/);
      expect(diagnostics.dataDir).toContain(
        path.join('profiles', diagnostics.databaseProfile ?? '', 'pgdata')
      );
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('fails fast with concurrency category when lock is held by another process', async () => {
    const lockError = new Error('lock exists') as Error & { code: string };
    lockError.code = 'EEXIST';
    writeFileSyncMock.mockImplementationOnce(() => {
      throw lockError;
    });
    readFileSyncMock.mockReturnValueOnce('424242');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

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

  it('reuses a self-owned database process lock', async () => {
    const lockError = new Error('lock exists') as Error & { code: string };
    lockError.code = 'EEXIST';
    writeFileSyncMock.mockImplementationOnce(() => {
      throw lockError;
    });
    readFileSyncMock.mockImplementation((candidate: string) =>
      String(candidate).endsWith('.db-process.lock') ? String(process.pid) : ''
    );

    const { initializeMainDatabase } = await import('../../db-main');
    await initializeMainDatabase();

    expect(unlinkSyncMock).not.toHaveBeenCalledWith(expect.stringContaining('.db-process.lock'));
    expect(PGliteMock).toHaveBeenCalledTimes(1);
  });

  it('replaces a stale database process lock when the owner pid is unreadable', async () => {
    const lockError = new Error('lock exists') as Error & { code: string };
    lockError.code = 'EEXIST';
    writeFileSyncMock.mockImplementationOnce(() => {
      throw lockError;
    });
    readFileSyncMock.mockImplementation((candidate: string) =>
      String(candidate).endsWith('.db-process.lock') ? 'not-a-pid' : ''
    );

    const { initializeMainDatabase } = await import('../../db-main');
    await initializeMainDatabase();

    expect(unlinkSyncMock).toHaveBeenCalledWith(expect.stringContaining('.db-process.lock'));
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining('.db-process.lock'),
      String(process.pid),
      { encoding: 'utf8', flag: 'wx' }
    );
  });

  it('treats EPERM during lock owner probing as a live database process', async () => {
    const lockError = new Error('lock exists') as Error & { code: string };
    lockError.code = 'EEXIST';
    writeFileSyncMock.mockImplementationOnce(() => {
      throw lockError;
    });
    readFileSyncMock.mockImplementation((candidate: string) =>
      String(candidate).endsWith('.db-process.lock') ? '424242' : ''
    );
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const permissionError = new Error('operation not permitted') as Error & { code: string };
      permissionError.code = 'EPERM';
      throw permissionError;
    });

    try {
      const { initializeMainDatabase } = await import('../../db-main');
      await expect(initializeMainDatabase()).rejects.toThrow(/Database lock is held by process/);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('surfaces a generic lock error when stale-lock retry loses to an unreadable owner', async () => {
    const lockError = new Error('lock exists') as Error & { code: string };
    lockError.code = 'EEXIST';
    writeFileSyncMock.mockImplementationOnce(() => {
      throw lockError;
    });
    writeFileSyncMock.mockImplementationOnce(() => {
      throw lockError;
    });
    readFileSyncMock.mockImplementation((candidate: string) =>
      String(candidate).endsWith('.db-process.lock') ? 'not-a-pid' : ''
    );

    const { initializeMainDatabase } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(
      /Database lock is held by another process/
    );
  });

  it('surfaces a friendly concurrency error when lock is claimed during stale-lock recovery', async () => {
    const lockError = new Error('lock exists') as Error & { code: string };
    lockError.code = 'EEXIST';
    writeFileSyncMock.mockImplementationOnce(() => {
      throw lockError;
    });
    writeFileSyncMock.mockImplementationOnce(() => {
      throw lockError;
    });
    readFileSyncMock.mockReturnValueOnce('11111').mockReturnValueOnce('22222');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 11_111) {
        const missingProcessError = new Error('process does not exist') as Error & { code: string };
        missingProcessError.code = 'ESRCH';
        throw missingProcessError;
      }
      return true;
    });

    try {
      const { initializeMainDatabase, getDatabaseDiagnostics } = await import('../../db-main');
      await expect(initializeMainDatabase()).rejects.toThrow(
        /Database lock is held by process 22222/
      );
      const diagnostics = getDatabaseDiagnostics();
      expect(diagnostics.lastInitializationFailure?.category).toBe('concurrency');
      expect(diagnostics.lastInitializationFailure?.stage).toBe('open-database');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('serializes PGlite initialization with a profile-scoped startup lock', async () => {
    process.env['BRAINSTRIKE_SERIALIZE_PGLITE_INIT'] = '1';
    readFileSyncMock.mockImplementation((candidate: string) => {
      if (candidate.includes('brainstrike-pglite-initialization-')) {
        return String(process.pid);
      }
      return '';
    });

    const { initializeMainDatabase } = await import('../../db-main');
    await initializeMainDatabase();

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/brainstrike-pglite-initialization-[a-f0-9]{16}\.lock$/),
      String(process.pid),
      { encoding: 'utf8', flag: 'wx' }
    );
    expect(unlinkSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/brainstrike-pglite-initialization-[a-f0-9]{16}\.lock$/)
    );
    expect(PGliteMock).toHaveBeenCalledTimes(1);
    expect(writeFileSyncMock.mock.invocationCallOrder[0]).toBeLessThan(
      PGliteMock.mock.invocationCallOrder[0] ?? 0
    );
    expect(migrateMock.mock.invocationCallOrder[0]).toBeLessThan(
      unlinkSyncMock.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('does not share the serialized PGlite startup lock across isolated database roots', async () => {
    process.env['BRAINSTRIKE_SERIALIZE_PGLITE_INIT'] = '1';
    process.env['BRAINSTRIKE_DB_ROOT_PATH'] = '/tmp/brainstrike-e2e-profile-a';
    readFileSyncMock.mockImplementation((candidate: string) => {
      if (candidate.includes('brainstrike-pglite-initialization-')) {
        return String(process.pid);
      }
      return '';
    });

    const firstImport = await import('../../db-main');
    await firstImport.initializeMainDatabase();
    const firstLockPath = getPGliteInitializationLockWritePath();

    vi.resetModules();
    vi.clearAllMocks();
    process.env['BRAINSTRIKE_SERIALIZE_PGLITE_INIT'] = '1';
    process.env['BRAINSTRIKE_DB_ROOT_PATH'] = '/tmp/brainstrike-e2e-profile-b';
    readFileSyncMock.mockImplementation((candidate: string) => {
      if (candidate.includes('brainstrike-pglite-initialization-')) {
        return String(process.pid);
      }
      return '';
    });

    const secondImport = await import('../../db-main');
    await secondImport.initializeMainDatabase();
    const secondLockPath = getPGliteInitializationLockWritePath();

    expect(firstLockPath).not.toBe(secondLockPath);
  });

  it('uses the same serialized PGlite startup lock for the same isolated database root', async () => {
    process.env['BRAINSTRIKE_SERIALIZE_PGLITE_INIT'] = '1';
    process.env['BRAINSTRIKE_DB_ROOT_PATH'] = '/tmp/brainstrike-e2e-profile-a';
    readFileSyncMock.mockImplementation((candidate: string) => {
      if (candidate.includes('brainstrike-pglite-initialization-')) {
        return String(process.pid);
      }
      return '';
    });

    const firstImport = await import('../../db-main');
    await firstImport.initializeMainDatabase();
    const firstLockPath = getPGliteInitializationLockWritePath();

    vi.resetModules();
    vi.clearAllMocks();
    process.env['BRAINSTRIKE_SERIALIZE_PGLITE_INIT'] = '1';
    process.env['BRAINSTRIKE_DB_ROOT_PATH'] = '/tmp/brainstrike-e2e-profile-a';
    readFileSyncMock.mockImplementation((candidate: string) => {
      if (candidate.includes('brainstrike-pglite-initialization-')) {
        return String(process.pid);
      }
      return '';
    });

    const secondImport = await import('../../db-main');
    await secondImport.initializeMainDatabase();
    const secondLockPath = getPGliteInitializationLockWritePath();

    expect(firstLockPath).toBe(secondLockPath);
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

  it('does not auto-recover from wasm abort during initialization', async () => {
    const wasmAbort = new Error('Aborted(). Build with -sASSERTIONS for more info.');

    PGliteMock.mockImplementationOnce(function (this: Record<string, unknown>) {
      Object.assign(this, {});
      throw wasmAbort;
    });

    const { initializeMainDatabase, getDatabaseDiagnostics } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(/aborted/i);
    expect(rmSyncMock).not.toHaveBeenCalled();
    const diagnostics = getDatabaseDiagnostics();
    expect(diagnostics.lastInitializationFailure?.category).toBe('wasm-runtime');
    expect(diagnostics.lastInitializationFailure?.stage).toBe('open-database');
  });

  it('closes partially initialized database instance when startup validation fails', async () => {
    const wasmAbort = new Error('Aborted(). Build with -sASSERTIONS for more info.');
    queryMock.mockRejectedValueOnce(wasmAbort);

    const { initializeMainDatabase, getDatabaseDiagnostics } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(/aborted/i);

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(rmSyncMock).not.toHaveBeenCalled();

    const diagnostics = getDatabaseDiagnostics();
    expect(diagnostics.lastInitializationFailure?.category).toBe('wasm-runtime');
    expect(diagnostics.lastInitializationFailure?.stage).toBe('open-database');
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
      // Reset backups now exclude engine-upgrade `.bak` siblings via a filter.
      expect.objectContaining({
        errorOnExist: true,
        filter: expect.any(Function),
        force: false,
        recursive: true,
      })
    );
    expect(rmSyncMock).toHaveBeenCalledWith(expectedAppDataPath, { force: true, recursive: true });
  });

  it('prunes stale profile backups during reset', async () => {
    process.env['NODE_ENV'] = 'development';
    process.env['BRAINSTRIKE_DB_PROFILE'] = 'test-profile';
    vi.resetModules();
    readdirSyncMock.mockReturnValueOnce([
      { isDirectory: () => true, name: 'test-profile-2026-02-15T07-00-00-000Z' },
      { isDirectory: () => true, name: 'test-profile-2026-02-14T07-00-00-000Z' },
      { isDirectory: () => true, name: 'test-profile-2026-02-13T07-00-00-000Z' },
      { isDirectory: () => true, name: 'test-profile-2026-02-12T07-00-00-000Z' },
      { isDirectory: () => true, name: 'test-profile-2026-02-11T07-00-00-000Z' },
      { isDirectory: () => true, name: 'test-profile-2026-02-10T07-00-00-000Z' },
      { isDirectory: () => true, name: 'other-profile-2026-02-10T07-00-00-000Z' },
    ]);

    const { resetLocalDatabase } = await import('../../db-main');
    await resetLocalDatabase();

    const backupRootPath = path.join('/mock/documents', 'BrainStrike-dev', 'backups');
    expect(readdirSyncMock).toHaveBeenCalledWith(backupRootPath, { withFileTypes: true });
    expect(rmSyncMock).toHaveBeenCalledWith(
      path.join(backupRootPath, 'test-profile-2026-02-10T07-00-00-000Z'),
      { force: true, recursive: true }
    );
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

  it('exposes a test-only helper to reset mutable diagnostics state', async () => {
    const { initializeMainDatabase, getDatabaseDiagnostics, __resetDatabaseModuleStateForTests } =
      await import('../../db-main');

    await initializeMainDatabase();
    expect(getDatabaseDiagnostics().initializationAttemptCount).toBeGreaterThan(0);

    __resetDatabaseModuleStateForTests();

    const diagnostics = getDatabaseDiagnostics();
    expect(diagnostics.initializationAttemptCount).toBe(0);
    expect(diagnostics.lastInitializationFailure).toBeNull();
    expect(diagnostics.runtimeCorruptionRecoveryCount).toBe(0);
  });
});
