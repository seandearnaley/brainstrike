import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real filesystem in a temp root. The calls that could reset or replace the database are recorded,
// so "never resets" is observed rather than assumed; `order` records the open-path steps.
const probe = vi.hoisted(() => ({
  destructive: [] as string[],
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  order: [] as string[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const probed = {
    ...actual,
    cpSync: (...args: Parameters<typeof actual.cpSync>) => {
      probe.destructive.push('cpSync');
      return actual.cpSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      probe.destructive.push('rmSync');
      return actual.rmSync(...args);
    },
  };
  return { ...probed, default: probed };
});

interface RebuildResult {
  readonly rebuilt: readonly {
    readonly accessMethod: string;
    readonly durationMs: number;
    readonly index: string;
    readonly schema: string;
    readonly table: string;
  }[];
  readonly totalDurationMs: number;
}

const REBUILD_RESULT: RebuildResult = {
  rebuilt: [
    {
      accessMethod: 'bm25',
      durationMs: 11_800,
      index: 'idx_file_chunks_content_bm25',
      schema: 'public',
      table: 'file_chunks',
    },
  ],
  totalDurationMs: 11_800,
};

const engine = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  createBrainstrikePglite: vi.fn(),
  exec: vi.fn(async () => undefined),
  migrate: vi.fn(),
  query: vi.fn(async () => ({ rows: [{ '?column?': 1 }] })),
  rebuildCrashSensitiveIndexes: vi.fn(),
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
  return { ...actual, createLogger: () => probe.logger };
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

const REBUILD_WARNING = 'Rebuilt crash-sensitive indexes after an unclean shutdown';

describe('db-main crash-sensitive index rebuild', () => {
  let rootPath: string;
  let appDataDir: string;
  let handle: object;

  const markerPath = (): string => path.join(appDataDir, '.db-clean-shutdown');
  const lockPath = (): string => path.join(appDataDir, '.db-process.lock');
  const seedDatabaseDirectory = (options: { readonly marker: boolean }): void => {
    mkdirSync(path.join(appDataDir, 'pgdata'), { recursive: true });
    writeFileSync(path.join(appDataDir, 'pgdata', 'PG_VERSION'), '18');
    if (options.marker) {
      writeFileSync(markerPath(), '{}');
    }
  };
  const rebuildWarnings = (): unknown[][] =>
    probe.logger.warn.mock.calls.filter(([message]) => message === REBUILD_WARNING);

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    rootPath = mkdtempSync(path.join(tmpdir(), 'brainstrike-db-crash-recovery-'));
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
    probe.destructive.length = 0;
    probe.order.length = 0;
    handle = {
      close: engine.close,
      exec: engine.exec,
      query: engine.query,
      syncToFs: engine.syncToFs,
    };
    engine.createBrainstrikePglite.mockImplementation(async () => {
      probe.order.push('open');
      return handle;
    });
    engine.migrate.mockImplementation(async () => {
      probe.order.push('migrate');
    });
    engine.rebuildCrashSensitiveIndexes.mockImplementation(async () => {
      probe.order.push('rebuild');
      return REBUILD_RESULT;
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

  describe('after an unclean shutdown', () => {
    it('rebuilds on the open handle after it opens and before migrations run', async () => {
      seedDatabaseDirectory({ marker: false });
      const { initializeMainDatabase } = await import('../../db-main');

      await initializeMainDatabase();

      expect(probe.order).toEqual(['open', 'rebuild', 'migrate']);
      expect(engine.rebuildCrashSensitiveIndexes).toHaveBeenCalledTimes(1);
      expect(engine.rebuildCrashSensitiveIndexes).toHaveBeenCalledWith(handle);
      expect(probe.destructive).toEqual([]);
    });

    it('records the result in the diagnostics and logs it once at warn', async () => {
      seedDatabaseDirectory({ marker: false });
      const { getDatabaseDiagnostics, initializeMainDatabase } = await import('../../db-main');

      await initializeMainDatabase();

      expect(getDatabaseDiagnostics()).toMatchObject({
        crashRecoveryIndexRebuild: REBUILD_RESULT,
        previousShutdown: 'unclean',
      });
      expect(rebuildWarnings()).toEqual([[REBUILD_WARNING, REBUILD_RESULT]]);
    });

    it('reports null once a clean close makes the next open clean', async () => {
      seedDatabaseDirectory({ marker: false });
      const { closeDatabase, getDatabaseDiagnostics, initializeMainDatabase } = await import(
        '../../db-main'
      );
      await initializeMainDatabase();
      await closeDatabase();

      await initializeMainDatabase();

      expect(getDatabaseDiagnostics()).toMatchObject({
        crashRecoveryIndexRebuild: null,
        previousShutdown: 'clean',
      });
      expect(engine.rebuildCrashSensitiveIndexes).toHaveBeenCalledTimes(1);
    });
  });

  describe.each([
    { name: 'a clean shutdown', seed: true, shutdown: 'clean' },
    { name: 'a new database', seed: false, shutdown: 'new-database' },
  ] as const)('after $name', ({ seed, shutdown }) => {
    it('never rebuilds and reports no rebuild', async () => {
      if (seed) {
        seedDatabaseDirectory({ marker: true });
      }
      const { getDatabaseDiagnostics, initializeMainDatabase } = await import('../../db-main');

      await initializeMainDatabase();

      expect(probe.order).toEqual(['open', 'migrate']);
      expect(engine.rebuildCrashSensitiveIndexes).not.toHaveBeenCalled();
      expect(getDatabaseDiagnostics()).toMatchObject({
        crashRecoveryIndexRebuild: null,
        previousShutdown: shutdown,
      });
      expect(rebuildWarnings()).toEqual([]);
    });
  });

  describe('when the rebuild fails', () => {
    const rebuildFailure = new Error(
      'Failed to rebuild crash-sensitive index "idx_file_chunks_content_bm25": could not read block 7'
    );
    const failRebuildOnce = (error: Error): void => {
      engine.rebuildCrashSensitiveIndexes.mockImplementationOnce(async () => {
        probe.order.push('rebuild');
        throw error;
      });
    };

    it('fails the open as corruption with the truthful copy, before migrations and without deleting anything', async () => {
      seedDatabaseDirectory({ marker: false });
      failRebuildOnce(rebuildFailure);
      const { getDatabaseDiagnostics, initializeMainDatabase } = await import('../../db-main');

      await expect(initializeMainDatabase()).rejects.toThrow(
        'The desktop database could not rebuild its search index after an unexpected shutdown: Failed to rebuild crash-sensitive index "idx_file_chunks_content_bm25": could not read block 7. BrainStrike did not delete or replace it.'
      );

      expect(engine.migrate).not.toHaveBeenCalled();
      expect(probe.destructive).toEqual([]);
      expect(engine.close).toHaveBeenCalledTimes(1);
      expect(existsSync(lockPath())).toBe(false);
      expect(existsSync(markerPath())).toBe(false);
      expect(getDatabaseDiagnostics()).toMatchObject({
        crashRecoveryIndexRebuild: null,
        hasDatabaseHandle: false,
        lastInitializationFailure: { category: 'corruption', stage: 'index-rebuild' },
      });
      expect(rebuildWarnings()).toEqual([]);
    });

    it('keeps the rebuild failure as the cause, without a doubled period in the copy', async () => {
      seedDatabaseDirectory({ marker: false });
      const failure = new Error('could not read block 7.');
      failRebuildOnce(failure);
      const { initializeMainDatabase } = await import('../../db-main');

      const rejection = await initializeMainDatabase().then(
        () => null,
        (error: unknown) => error
      );

      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).cause).toBe(failure);
      expect((rejection as Error).message).toBe(
        'The desktop database could not rebuild its search index after an unexpected shutdown: could not read block 7. BrainStrike did not delete or replace it.'
      );
    });

    it.each([
      ['its message', new Error('could not extend file "base/5/16384": No space left on device')],
      [
        'its ENOSPC code alone',
        Object.assign(new Error('could not extend file "base/5/16384"'), { code: 'ENOSPC' }),
      ],
    ])(
      'reports a rebuild that ran out of disk (by %s) as a filesystem failure, not corruption',
      async (_label, error) => {
        seedDatabaseDirectory({ marker: false });
        failRebuildOnce(error);
        const { getDatabaseDiagnostics, initializeMainDatabase } = await import('../../db-main');

        await expect(initializeMainDatabase()).rejects.toThrow(
          /could not rebuild its search index/
        );

        expect(getDatabaseDiagnostics().lastInitializationFailure).toMatchObject({
          category: 'filesystem',
          stage: 'index-rebuild',
        });
        expect(probe.destructive).toEqual([]);
      }
    );

    it('leaves a disk-full migration failure classified as a migration failure', async () => {
      // The disk-full rule is scoped to the rebuild stage; other stages keep their categories.
      seedDatabaseDirectory({ marker: true });
      engine.migrate.mockImplementationOnce(async () => {
        throw new Error('could not extend file "base/5/16384": No space left on device');
      });
      const { getDatabaseDiagnostics, initializeMainDatabase } = await import('../../db-main');

      await expect(initializeMainDatabase()).rejects.toThrow(/No space left on device/);

      expect(getDatabaseDiagnostics().lastInitializationFailure).toMatchObject({
        category: 'migration',
        stage: 'migration',
      });
    });

    it('still reports a WASM abort during the rebuild as the runtime failure it is', async () => {
      seedDatabaseDirectory({ marker: false });
      failRebuildOnce(new Error('Aborted(). Build with -sASSERTIONS for more info.'));
      const { getDatabaseDiagnostics, initializeMainDatabase } = await import('../../db-main');

      await expect(initializeMainDatabase()).rejects.toThrow(/could not rebuild its search index/);

      expect(getDatabaseDiagnostics().lastInitializationFailure).toMatchObject({
        category: 'wasm-runtime',
        stage: 'index-rebuild',
      });
      expect(probe.destructive).toEqual([]);
    });

    it('refuses a later open, with the restart message, when the cleanup close also fails', async () => {
      seedDatabaseDirectory({ marker: false });
      failRebuildOnce(rebuildFailure);
      engine.close.mockRejectedValueOnce(new Error('close failed'));
      const { getDatabase, getDatabaseDiagnostics, initializeMainDatabase } = await import(
        '../../db-main'
      );

      await expect(initializeMainDatabase()).rejects.toThrow(/could not rebuild its search index/);
      await expect(getDatabase()).rejects.toMatchObject({
        message: expect.stringMatching(/may still own the data directory.*restart BrainStrike/),
        name: 'DatabaseCloseError',
        stage: 'close',
      });

      expect(engine.createBrainstrikePglite).toHaveBeenCalledTimes(1);
      expect(engine.rebuildCrashSensitiveIndexes).toHaveBeenCalledTimes(1);
      expect(existsSync(lockPath())).toBe(true);
      expect(existsSync(markerPath())).toBe(false);
      expect(probe.destructive).toEqual([]);
      expect(getDatabaseDiagnostics()).toMatchObject({
        closeFailure: { stage: 'close' },
        crashRecoveryIndexRebuild: null,
        lastInitializationFailure: { category: 'corruption', stage: 'index-rebuild' },
      });
    });

    it('rebuilds again on the next open, which still reads as unclean', async () => {
      seedDatabaseDirectory({ marker: false });
      failRebuildOnce(rebuildFailure);
      const { getDatabase, getDatabaseDiagnostics, initializeMainDatabase } = await import(
        '../../db-main'
      );
      await expect(initializeMainDatabase()).rejects.toThrow(/could not rebuild its search index/);

      await getDatabase();

      expect(probe.order).toEqual(['open', 'rebuild', 'open', 'rebuild', 'migrate']);
      expect(getDatabaseDiagnostics()).toMatchObject({
        crashRecoveryIndexRebuild: REBUILD_RESULT,
        lastInitializationFailure: null,
        previousShutdown: 'unclean',
      });
    });
  });
});
