import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real filesystem in a temp root, so locks, markers and resets are observed on disk.
// Only the calls whose ORDER matters are wrapped (and recorded), and one can be made to fail.
const fsProbe = vi.hoisted(() => ({
  events: [] as string[],
  failMarkerUnlink: false,
  markerPresentWhenOpened: null as boolean | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const probed = {
    ...actual,
    fsyncSync: (descriptor: number) => {
      fsProbe.events.push('fsync');
      actual.fsyncSync(descriptor);
    },
    renameSync: (from: string, to: string) => {
      fsProbe.events.push(`rename:${String(to).split('/').at(-1)}`);
      actual.renameSync(from, to);
    },
    unlinkSync: (target: string) => {
      const name = String(target).split('/').at(-1) ?? '';
      fsProbe.events.push(`unlink:${name}`);
      if (fsProbe.failMarkerUnlink && name === '.db-clean-shutdown') {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      actual.unlinkSync(target);
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
  syncToFs: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/unused') } }));
vi.mock('@brainstrike/db/pglite-factory', () => ({
  createBrainstrikePglite: engine.createBrainstrikePglite,
}));
vi.mock('@brainstrike/db', () => ({ migrate: engine.migrate }));
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

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

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
    process.env['BRAINSTRIKE_DB_ROOT_PATH'] = rootPath;
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      value: { on: vi.fn(), postMessage: vi.fn() },
      writable: true,
    });
    fsProbe.events.length = 0;
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
