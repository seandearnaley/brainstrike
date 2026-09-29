import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real filesystem in a temp root, so locks, markers and resets are observed on disk.
// Only the calls whose ORDER matters are wrapped (and recorded), and one can be made to fail.
const fsProbe = vi.hoisted(() => ({
  afterLockUnlink: null as (() => void) | null,
  events: [] as string[],
  failMarkerUnlink: false,
  markerPresentWhenOpened: null as boolean | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const probed = {
    ...actual,
    cpSync: (...args: Parameters<typeof actual.cpSync>) => {
      fsProbe.events.push(`cp:${path.basename(String(args[0]))}`);
      actual.cpSync(...args);
    },
    fsyncSync: (descriptor: number) => {
      fsProbe.events.push('fsync');
      actual.fsyncSync(descriptor);
    },
    renameSync: (from: string, to: string) => {
      fsProbe.events.push(`rename:${path.basename(String(to))}`);
      actual.renameSync(from, to);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      fsProbe.events.push(`rm:${path.basename(String(args[0]))}`);
      actual.rmSync(...args);
    },
    unlinkSync: (target: string) => {
      const name = path.basename(String(target));
      fsProbe.events.push(`unlink:${name}`);
      if (fsProbe.failMarkerUnlink && name === '.db-clean-shutdown') {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      actual.unlinkSync(target);
      if (name === '.db-process.lock') {
        fsProbe.afterLockUnlink?.();
      }
    },
  };
  return { ...probed, default: probed };
});

const engine = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  createBrainstrikePglite: vi.fn(),
  exec: vi.fn(async () => undefined),
  migrate: vi.fn(async () => undefined),
  query: vi.fn(async () => ({ rows: [{ '?column?': 1 }] })),
  rebuildCrashSensitiveIndexes: vi.fn(async () => ({ rebuilt: [], totalDurationMs: 0 })),
  syncToFs: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/unused') } }));
vi.mock('@brainstrike/db/pglite-factory', () => ({
  createBrainstrikePglite: engine.createBrainstrikePglite,
}));
vi.mock('@brainstrike/db', () => ({
  migrate: engine.migrate,
  rebuildCrashSensitiveIndexes: engine.rebuildCrashSensitiveIndexes,
}));
vi.mock('@brainstrike/logging', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/logging')>('@brainstrike/logging');
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  };
});

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');
const originalDbRootPath = process.env['BRAINSTRIKE_DB_ROOT_PATH'];
const originalDbProfile = process.env['BRAINSTRIKE_DB_PROFILE'];

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

const settle = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (error: unknown) => error
  );
const destructiveFsEvents = (): string[] =>
  fsProbe.events.filter((event) => event.startsWith('rm:') || event.startsWith('cp:'));
const nextTurn = (): Promise<unknown> => new Promise((resolve) => setImmediate(resolve));

describe('db-main close and open', () => {
  let rootPath: string;
  let appDataDir: string;

  const markerPath = (): string => path.join(appDataDir, '.db-clean-shutdown');
  const lockPath = (): string => path.join(appDataDir, '.db-process.lock');
  const pgVersionPath = (): string => path.join(appDataDir, 'pgdata', 'PG_VERSION');
  const seedDatabaseDirectory = (options: { readonly marker: boolean }): void => {
    mkdirSync(path.dirname(pgVersionPath()), { recursive: true });
    writeFileSync(pgVersionPath(), '18');
    if (options.marker) {
      writeFileSync(markerPath(), '{}');
    }
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    rootPath = mkdtempSync(path.join(tmpdir(), 'brainstrike-db-close-'));
    appDataDir = path.join(rootPath, 'profiles', 'test');
    process.env['NODE_ENV'] = 'test';
    // The DB host reads its location only from main's environment (BST-1873).
    process.env['BRAINSTRIKE_DB_ROOT_PATH'] = rootPath;
    process.env['BRAINSTRIKE_DB_PROFILE'] = 'test';
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      value: { on: vi.fn(), postMessage: vi.fn() },
      writable: true,
    });
    fsProbe.events.length = 0;
    fsProbe.afterLockUnlink = null;
    fsProbe.failMarkerUnlink = false;
    fsProbe.markerPresentWhenOpened = null;
    engine.createBrainstrikePglite.mockImplementation(async () => {
      fsProbe.markerPresentWhenOpened = existsSync(markerPath());
      return {
        close: engine.close,
        exec: engine.exec,
        query: engine.query,
        syncToFs: engine.syncToFs,
      };
    });
  });

  afterEach(() => {
    Object.defineProperty(
      process,
      'parentPort',
      originalParentPortDescriptor ?? { configurable: true, value: undefined, writable: true }
    );
    restoreEnvValue('BRAINSTRIKE_DB_ROOT_PATH', originalDbRootPath);
    restoreEnvValue('BRAINSTRIKE_DB_PROFILE', originalDbProfile);
    rmSync(rootPath, { force: true, recursive: true });
  });

  describe('previous shutdown', () => {
    it('is unknown until the database has opened', async () => {
      const { getDatabaseDiagnostics } = await import('../../db-main');
      expect(getDatabaseDiagnostics().previousShutdown).toBeNull();
    });

    it.each([
      { expected: 'clean', marker: true, name: 'a marker beside an existing database', seed: true },
      {
        expected: 'unclean',
        marker: false,
        name: 'an existing database with no marker',
        seed: true,
      },
      { expected: 'new-database', marker: true, name: 'no database on disk', seed: false },
    ] as const)(
      'reports $expected for $name and removes the marker before the database opens',
      async ({ expected, marker, seed }) => {
        if (seed) {
          seedDatabaseDirectory({ marker });
        } else {
          mkdirSync(appDataDir, { recursive: true });
          writeFileSync(markerPath(), '{}');
        }
        const { getDatabaseDiagnostics, initializeMainDatabase } = await import('../../db-main');

        await initializeMainDatabase();

        expect(getDatabaseDiagnostics().previousShutdown).toBe(expected);
        expect(fsProbe.markerPresentWhenOpened).toBe(false);
        expect(existsSync(markerPath())).toBe(false);
      }
    );

    it('fails the open as a filesystem failure, before the database opens, when the marker cannot be removed', async () => {
      seedDatabaseDirectory({ marker: true });
      fsProbe.failMarkerUnlink = true;
      const { getDatabaseDiagnostics, initializeMainDatabase } = await import('../../db-main');

      await expect(initializeMainDatabase()).rejects.toThrow(/filesystem access failed/);

      expect(engine.createBrainstrikePglite).not.toHaveBeenCalled();
      expect(getDatabaseDiagnostics().lastInitializationFailure).toMatchObject({
        category: 'filesystem',
        stage: 'open-database',
      });
      expect(existsSync(markerPath())).toBe(true);
    });
  });

  // Fail-closed by design: a directory where the marker belongs is not a marker and cannot be
  // removed as one, so the open stops with a filesystem failure rather than guess what it means.
  describe('a directory at the marker path', () => {
    it('fails every open as a filesystem failure, and deletes nothing', async () => {
      seedDatabaseDirectory({ marker: false });
      mkdirSync(markerPath());
      fsProbe.events.length = 0;
      const { getDatabaseDiagnostics, initializeMainDatabase } = await import('../../db-main');

      await expect(initializeMainDatabase()).rejects.toThrow(/filesystem access failed/);
      await expect(initializeMainDatabase()).rejects.toThrow(/filesystem access failed/);

      expect(engine.createBrainstrikePglite).not.toHaveBeenCalled();
      expect(getDatabaseDiagnostics().lastInitializationFailure).toMatchObject({
        category: 'filesystem',
        stage: 'open-database',
      });
      expect(destructiveFsEvents()).toEqual([]);
      expect(existsSync(markerPath())).toBe(true);
      expect(existsSync(pgVersionPath())).toBe(true);
    });
  });

  describe('a clean close', () => {
    it('writes the marker durably, strictly before it releases the lock', async () => {
      const { closeDatabase, initializeMainDatabase } = await import('../../db-main');
      await initializeMainDatabase();
      fsProbe.events.length = 0;

      await closeDatabase();

      // tmp file flushed, renamed over the marker, directory entry flushed (not on Windows), then the lock goes.
      expect(fsProbe.events).toEqual([
        'fsync',
        'rename:.db-clean-shutdown',
        ...(process.platform === 'win32' ? [] : ['fsync']),
        'unlink:.db-process.lock',
      ]);
      expect(JSON.parse(readFileSync(markerPath(), 'utf8'))).toMatchObject({ pid: process.pid });
      expect(existsSync(lockPath())).toBe(false);
    });

    it('reads as clean on the next open', async () => {
      const { closeDatabase, getDatabaseDiagnostics, initializeMainDatabase } = await import(
        '../../db-main'
      );
      seedDatabaseDirectory({ marker: false });
      await initializeMainDatabase();
      expect(getDatabaseDiagnostics().previousShutdown).toBe('unclean');
      await closeDatabase();

      await initializeMainDatabase();

      expect(getDatabaseDiagnostics().previousShutdown).toBe('clean');
    });
  });

  describe('a failed close', () => {
    it.each([
      { failure: 'syncToFs', stage: 'sync' },
      { failure: 'close', stage: 'close' },
    ] as const)(
      'rejects DatabaseCloseError at stage $stage, keeps the lock, and writes no marker',
      async ({ failure, stage }) => {
        const { closeDatabase, getDatabaseDiagnostics, initializeMainDatabase } = await import(
          '../../db-main'
        );
        await initializeMainDatabase();
        engine[failure].mockRejectedValueOnce(new Error(`${failure} failed`));

        await expect(closeDatabase()).rejects.toMatchObject({
          cause: expect.objectContaining({ message: `${failure} failed` }),
          name: 'DatabaseCloseError',
          stage,
        });

        // A failed sync still closes the handle: close runs PGlite's shutdown checkpoint.
        expect(engine.close).toHaveBeenCalledTimes(1);
        expect(existsSync(lockPath())).toBe(true);
        expect(existsSync(markerPath())).toBe(false);
        expect(getDatabaseDiagnostics()).toMatchObject({
          databaseLockHeld: true,
          hasDatabaseHandle: false,
        });
      }
    );

    it.each([
      { failure: 'syncToFs', owns: false, words: /database sync failed.*restart BrainStrike/ },
      { failure: 'close', owns: true, words: /database close failed.*may still own/ },
    ] as const)(
      'refuses a later open after a failed $failure with the message for that stage',
      async ({ failure, owns, words }) => {
        const { closeDatabase, getDatabase, initializeMainDatabase } = await import(
          '../../db-main'
        );
        await initializeMainDatabase();
        engine[failure].mockRejectedValueOnce(new Error(`${failure} failed`));
        await expect(closeDatabase()).rejects.toMatchObject({ name: 'DatabaseCloseError' });

        const reopen = await getDatabase().then(
          () => null,
          (error: unknown) => error as Error
        );

        expect(reopen?.message).toMatch(words);
        // After a failed sync the close itself succeeded: the handle no longer owns anything.
        expect(reopen?.message.includes('may still own')).toBe(owns);
      }
    );

    it('reports the close stage when both the sync and the close fail', async () => {
      const { closeDatabase, initializeMainDatabase } = await import('../../db-main');
      await initializeMainDatabase();
      engine.syncToFs.mockRejectedValueOnce(new Error('sync failed'));
      engine.close.mockRejectedValueOnce(new Error('close failed'));

      await expect(closeDatabase()).rejects.toMatchObject({ stage: 'close' });
    });

    it('aborts a host-side reset before anything is deleted', async () => {
      const { initializeMainDatabase, resetLocalDatabase } = await import('../../db-main');
      await initializeMainDatabase();
      seedDatabaseDirectory({ marker: false });
      engine.close.mockRejectedValueOnce(new Error('close failed'));

      await expect(resetLocalDatabase()).rejects.toMatchObject({ name: 'DatabaseCloseError' });

      expect(existsSync(pgVersionPath())).toBe(true);
      expect(existsSync(lockPath())).toBe(true);
    });

    it('resets normally once the close is clean', async () => {
      const { initializeMainDatabase, resetLocalDatabase } = await import('../../db-main');
      await initializeMainDatabase();
      seedDatabaseDirectory({ marker: false });

      await resetLocalDatabase();

      expect(existsSync(pgVersionPath())).toBe(false);
      expect(existsSync(path.join(appDataDir, 'pgdata'))).toBe(true);
    });
  });

  // A handle whose close failed may still own the data directory, so nothing may reopen, reset,
  // recover from corruption over it, or report a close, until the process exits.
  describe('a failed close is sticky', () => {
    async function failTheFirstClose() {
      const db = await import('../../db-main');
      await db.initializeMainDatabase();
      engine.close.mockRejectedValueOnce(new Error('close failed'));
      const first = await settle(db.closeDatabase());
      fsProbe.events.length = 0;
      return { ...db, first };
    }

    it('rejects every later close with the first failure as its cause, never reporting success', async () => {
      const { closeDatabase, first } = await failTheFirstClose();
      expect(first).toMatchObject({ name: 'DatabaseCloseError', stage: 'close' });

      const second = await settle(closeDatabase());

      expect(second).toMatchObject({ name: 'DatabaseCloseError', stage: 'close' });
      expect((second as Error).cause).toBe(first);
      expect(engine.close).toHaveBeenCalledTimes(1);
      expect(existsSync(lockPath())).toBe(true);
      expect(existsSync(markerPath())).toBe(false);
    });

    it('aborts a reset before any backup or deletion, and keeps the lock', async () => {
      const { resetLocalDatabase } = await failTheFirstClose();
      seedDatabaseDirectory({ marker: false });

      await expect(resetLocalDatabase()).rejects.toMatchObject({ name: 'DatabaseCloseError' });

      expect(destructiveFsEvents()).toEqual([]);
      expect(existsSync(pgVersionPath())).toBe(true);
      expect(existsSync(lockPath())).toBe(true);
    });

    it.each(['getDatabase', 'initializeMainDatabase', 'reinitializeDatabase'] as const)(
      'refuses to reopen through %s while the failed handle may own the data directory',
      async (entry) => {
        const db = await failTheFirstClose();
        engine.createBrainstrikePglite.mockClear();

        await expect(db[entry]()).rejects.toMatchObject({ name: 'DatabaseCloseError' });

        expect(engine.createBrainstrikePglite).not.toHaveBeenCalled();
        expect(existsSync(lockPath())).toBe(true);
      }
    );

    it('never deletes the data directory during runtime corruption recovery', async () => {
      const { getDatabaseDiagnostics, handleRuntimeCorruption, initializeMainDatabase } =
        await import('../../db-main');
      await initializeMainDatabase();
      seedDatabaseDirectory({ marker: false });
      fsProbe.events.length = 0;
      engine.close.mockRejectedValueOnce(new Error('close failed'));

      await expect(handleRuntimeCorruption('db:query')).rejects.toMatchObject({
        name: 'DatabaseCloseError',
        stage: 'close',
      });

      expect(destructiveFsEvents()).toEqual([]);
      expect(existsSync(pgVersionPath())).toBe(true);
      expect(existsSync(lockPath())).toBe(true);
      expect(getDatabaseDiagnostics().closeFailure).toEqual({
        message: expect.stringContaining('close failed'),
        stage: 'close',
      });
    });

    it('is reported in diagnostics only once a close has failed', async () => {
      const { getDatabaseDiagnostics, initializeMainDatabase } = await import('../../db-main');
      expect(getDatabaseDiagnostics().closeFailure).toBeNull();
      await initializeMainDatabase();
      expect(getDatabaseDiagnostics().closeFailure).toBeNull();
    });

    // With closes waiting for an in-flight open, the failing close here is the open's own cleanup.
    it('keeps the lock when a close waits for a failing open whose own cleanup close fails', async () => {
      let failMigration: (error: Error) => void = () => undefined;
      engine.migrate.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failMigration = reject;
          })
      );
      engine.close.mockRejectedValueOnce(new Error('close failed'));
      const { closeDatabase, getDatabaseDiagnostics, initializeMainDatabase } = await import(
        '../../db-main'
      );
      const opening = settle(initializeMainDatabase());
      await vi.waitFor(() => expect(engine.migrate).toHaveBeenCalledTimes(1));
      const closing = settle(closeDatabase());
      await nextTurn();

      failMigration(new Error('relation already exists'));
      await opening;
      await closing;

      expect(existsSync(lockPath())).toBe(true);
      expect(getDatabaseDiagnostics().closeFailure).toMatchObject({ stage: 'close' });
    });

    it.each([
      {
        failure: 'validation',
        inject: () =>
          engine.query.mockRejectedValueOnce(new Error('Aborted(). Build with -sASSERTIONS')),
        opened: /aborted/i,
      },
      {
        failure: 'migration',
        inject: () => engine.migrate.mockRejectedValueOnce(new Error('relation already exists')),
        opened: /migrations failed/i,
      },
    ] as const)(
      'refuses a later open, with the restart message, when the failed $failure close also fails',
      async ({ inject, opened }) => {
        inject();
        engine.close.mockRejectedValueOnce(new Error('close failed'));
        const { getDatabase, getDatabaseDiagnostics, initializeMainDatabase } = await import(
          '../../db-main'
        );
        await expect(initializeMainDatabase()).rejects.toThrow(opened);

        const later = await settle(getDatabase());

        expect(later).toMatchObject({ name: 'DatabaseCloseError', stage: 'close' });
        expect((later as Error).message).toMatch(/may still own the data directory/);
        expect((later as Error).message).toMatch(/restart BrainStrike/i);
        expect(engine.createBrainstrikePglite).toHaveBeenCalledTimes(1);
        expect(existsSync(lockPath())).toBe(true);
        expect(getDatabaseDiagnostics().closeFailure).toMatchObject({ stage: 'close' });
      }
    );
  });

  // A reset (or close) never runs while an open is in flight: it waits for the open to settle, then
  // closes what it produced, so nothing is backed up or deleted under a handle that is still opening.
  describe('a reset while the database is opening', () => {
    const gatedFactory = (): { readonly release: () => void } => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      engine.createBrainstrikePglite.mockImplementationOnce(async () => {
        await gate;
        return {
          close: engine.close,
          exec: engine.exec,
          query: engine.query,
          syncToFs: engine.syncToFs,
        };
      });
      return { release };
    };

    it('waits for the open, closes what it produced, and only then deletes', async () => {
      const { release } = gatedFactory();
      engine.close.mockImplementationOnce(async () => {
        fsProbe.events.push('engine-close');
      });
      const { getDatabase, resetLocalDatabase } = await import('../../db-main');
      const opening = getDatabase();
      await vi.waitFor(() => expect(engine.createBrainstrikePglite).toHaveBeenCalledTimes(1));
      seedDatabaseDirectory({ marker: false });
      fsProbe.events.length = 0;

      const resetting = settle(resetLocalDatabase());
      await nextTurn();
      expect(destructiveFsEvents()).toEqual([]);
      expect(engine.close).not.toHaveBeenCalled();

      release();
      await opening;
      expect(await resetting).toBeNull();

      const closeAt = fsProbe.events.indexOf('engine-close');
      const firstDeleteAt = fsProbe.events.findIndex(
        (event) => event.startsWith('rm:') || event.startsWith('cp:')
      );
      expect(closeAt).toBeGreaterThanOrEqual(0);
      expect(firstDeleteAt).toBeGreaterThan(closeAt);
      expect(existsSync(pgVersionPath())).toBe(false);
    });

    it('settles an open that starts between the close and the delete', async () => {
      const { getDatabase, initializeMainDatabase, resetLocalDatabase } = await import(
        '../../db-main'
      );
      await initializeMainDatabase();
      seedDatabaseDirectory({ marker: false });
      const { release } = gatedFactory();
      // The lock is released as the close finishes: a caller opens the database right then.
      fsProbe.afterLockUnlink = () => {
        fsProbe.afterLockUnlink = null;
        void getDatabase().catch(() => undefined);
      };
      fsProbe.events.length = 0;

      const resetting = settle(resetLocalDatabase());
      await nextTurn();
      expect(destructiveFsEvents()).toEqual([]);

      release();
      expect(await resetting).toBeNull();
      expect(engine.close).toHaveBeenCalledTimes(2);
      expect(existsSync(pgVersionPath())).toBe(false);
    });
  });

  describe('a reset whose database keeps reopening', () => {
    it('gives up after three closes without deleting anything', async () => {
      const { getDatabase, initializeMainDatabase, resetLocalDatabase } = await import(
        '../../db-main'
      );
      await initializeMainDatabase();
      seedDatabaseDirectory({ marker: false });
      // Every lock release is answered by a fresh open, so the reset can never quiesce.
      fsProbe.afterLockUnlink = () => {
        void getDatabase().catch(() => undefined);
      };
      fsProbe.events.length = 0;

      await expect(resetLocalDatabase()).rejects.toThrow(
        /reopened after each of 3 closes; nothing was deleted/
      );

      fsProbe.afterLockUnlink = null;
      expect(destructiveFsEvents()).toEqual([]);
      expect(engine.close).toHaveBeenCalledTimes(3);
      expect(existsSync(pgVersionPath())).toBe(true);
    });
  });

  // A handle is visible to readers only once it has validated: a concurrent caller either awaits
  // the single-flight initialization or fails with it, and never receives a half-open database.
  describe('a handle that is still opening', () => {
    it('is invisible to a concurrent getDatabase() until validation completes', async () => {
      let releaseValidation: () => void = () => undefined;
      engine.query.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseValidation = () => resolve({ rows: [{ '?column?': 1 }] });
          })
      );
      const { getDatabase, getDatabaseDiagnostics, initializeMainDatabase } = await import(
        '../../db-main'
      );
      const opening = initializeMainDatabase();
      await vi.waitFor(() => expect(engine.query).toHaveBeenCalledTimes(1));
      let concurrentSettled = false;
      const concurrent = getDatabase().finally(() => {
        concurrentSettled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(getDatabaseDiagnostics().hasDatabaseHandle).toBe(false);
      expect(concurrentSettled).toBe(false);

      releaseValidation();
      const [opened, seen] = await Promise.all([opening, concurrent]);
      expect(seen).toBe(opened);
      expect(getDatabaseDiagnostics().hasDatabaseHandle).toBe(true);
    });
  });

  describe('a failed open', () => {
    it('keeps the lock, and the migration error, when closing the un-migrated handle also fails', async () => {
      engine.migrate.mockRejectedValueOnce(new Error('relation already exists'));
      engine.close.mockRejectedValueOnce(new Error('close failed'));
      const { getDatabaseDiagnostics, initializeMainDatabase } = await import('../../db-main');

      await expect(initializeMainDatabase()).rejects.toThrow(
        'Database migrations failed with pgvector: relation already exists'
      );

      expect(existsSync(lockPath())).toBe(true);
      expect(getDatabaseDiagnostics()).toMatchObject({
        databaseLockHeld: true,
        hasDatabaseHandle: false,
      });
    });

    it('keeps the lock, and the validation error, when closing the half-open handle also fails', async () => {
      engine.query.mockRejectedValueOnce(new Error('Aborted(). Build with -sASSERTIONS'));
      engine.close.mockRejectedValueOnce(new Error('close failed'));
      const { initializeMainDatabase } = await import('../../db-main');

      await expect(initializeMainDatabase()).rejects.toThrow(/aborted/i);

      expect(existsSync(lockPath())).toBe(true);
    });

    it('releases the lock when the failed handle closes cleanly', async () => {
      engine.migrate.mockRejectedValueOnce(new Error('relation already exists'));
      const { initializeMainDatabase } = await import('../../db-main');

      await expect(initializeMainDatabase()).rejects.toThrow(/migrations failed/i);

      expect(existsSync(lockPath())).toBe(false);
    });
  });
});
