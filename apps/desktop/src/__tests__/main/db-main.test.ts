import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');

function installUtilityProcessParentPort(): void {
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    writable: true,
    value: {
      on: vi.fn(),
      postMessage: vi.fn(),
    },
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

const existsSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const openSyncMock = vi.fn(() => 123);
const writeFileSyncMock = vi.fn();
const closeSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const readFileSyncMock = vi.fn(() => '');
const readdirSyncMock = vi.fn(() => []);
const cpSyncMock = vi.fn();
const lstatSyncMock = vi.fn(() => ({
  isDirectory: () => false,
  isFile: () => false,
}));
const renameSyncMock = vi.fn();
const rmSyncMock = vi.fn();
const statSyncMock = vi.fn(() => ({
  mtimeMs: 0,
}));
const utimesSyncMock = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  openSync: openSyncMock,
  writeFileSync: writeFileSyncMock,
  closeSync: closeSyncMock,
  unlinkSync: unlinkSyncMock,
  readFileSync: readFileSyncMock,
  readdirSync: readdirSyncMock,
  lstatSync: lstatSyncMock,
  cpSync: cpSyncMock,
  renameSync: renameSyncMock,
  rmSync: rmSyncMock,
  statSync: statSyncMock,
  utimesSync: utimesSyncMock,
  default: {
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    openSync: openSyncMock,
    writeFileSync: writeFileSyncMock,
    closeSync: closeSyncMock,
    unlinkSync: unlinkSyncMock,
    readFileSync: readFileSyncMock,
    readdirSync: readdirSyncMock,
    lstatSync: lstatSyncMock,
    cpSync: cpSyncMock,
    renameSync: renameSyncMock,
    rmSync: rmSyncMock,
    statSync: statSyncMock,
    utimesSync: utimesSyncMock,
  },
}));

const appGetPathMock = vi.fn(() => '/mock/documents');
vi.mock('electron', () => ({ app: { getPath: appGetPathMock } }));

const migrateMock = vi.fn();
const runPgliteBootstrapCapabilityProbeMock = vi.fn();
const runTursoProfileBootstrapMock = vi.fn();
const loggerErrorMock = vi.fn();
const tursoOwnerQueryMock = vi.fn(async (sql: string, params?: readonly unknown[]) => ({
  rows: [{ sql, params, value: 'ok' }],
}));
const tursoOwnerExecMock = vi.fn(async () => {});
const tursoOwnerCloseMock = vi.fn(async () => {});
const tursoOwnerQoSDiagnosticsMock = vi.fn(() => ({
  activeOperation: null,
  queuedOperationCount: 0,
  queuedOperations: [],
  slowQueuedOperationCount: 0,
  slowQueueThresholdMs: 1000,
  totalCompletedOperations: 0,
  totalFailedOperations: 0,
  totalQueuedOperations: 0,
  totalStartedOperations: 0,
}));
const createTursoOwnerClientMock = vi.fn(async () => ({
  close: tursoOwnerCloseMock,
  exec: tursoOwnerExecMock,
  getQoSDiagnostics: tursoOwnerQoSDiagnosticsMock,
  query: tursoOwnerQueryMock,
}));
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
vi.mock('@electric-sql/pglite-pgvector', () => ({ vector: { name: 'vector' } }));
vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  migrate: migrateMock,
  resolveBrainstrikeDbRuntimeSelection: vi.fn(
    (input: {
      platform: 'desktop';
      requestedEngine?: 'pglite' | 'turso';
      source?: 'env' | 'default';
    }) => ({
      bootstrapRuntime: {
        engine: input.requestedEngine ?? 'pglite',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
      engine: input.requestedEngine ?? 'pglite',
      platform: input.platform,
      source: input.source ?? (input.requestedEngine ? 'env' : 'default'),
    })
  ),
  runPgliteBootstrapCapabilityProbe: runPgliteBootstrapCapabilityProbeMock,
}));
vi.mock('@brainstrike/db/bootstrap/turso-profile-bootstrap', () => ({
  runTursoProfileBootstrap: runTursoProfileBootstrapMock,
}));
vi.mock('@brainstrike/db/turso/owner-client', () => ({
  createTursoOwnerClient: createTursoOwnerClientMock,
}));

vi.mock('@brainstrike/utils', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils')>('@brainstrike/utils');
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: loggerErrorMock,
      debug: vi.fn(),
    }),
  };
});
vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerErrorMock,
    debug: vi.fn(),
  }),
}));

describe('initializeMainDatabase', () => {
  const originalArgv = [...process.argv];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installUtilityProcessParentPort();
    process.env['NODE_ENV'] = 'test';
    process.env['BRAINSTRIKE_DB_PROFILE'] = '';
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_DB_RUNTIME');
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_SERIALIZE_PGLITE_INIT');
    process.argv = [...originalArgv];
    runPgliteBootstrapCapabilityProbeMock.mockResolvedValue(createReadyBootstrapProbeReport());
    runTursoProfileBootstrapMock.mockResolvedValue(createReadyTursoProfileBootstrapReport());
  });

  afterEach(() => {
    restoreParentPort();
    process.argv = [...originalArgv];
  });

  it('creates directory, migrates, and returns singleton instance', async () => {
    existsSyncMock.mockReturnValue(false);
    // Mock getPath to return different paths for documents vs userData
    appGetPathMock.mockImplementation(((name: string) => `/mock/${name}`) as () => string);

    const { initializeMainDatabase } = await import('../../db-main');
    const db1 = await initializeMainDatabase();

    // In NODE_ENV=test, we expect it to use 'userData' path for isolation
    const expectedPath = path.join('/mock/userData', 'profiles', 'test', 'pgdata');

    expect(appGetPathMock).toHaveBeenCalledWith('userData');
    expect(mkdirSyncMock).toHaveBeenCalledWith(expectedPath, { recursive: true });
    expect(PGliteMock).toHaveBeenCalledTimes(1);
    // Verify PGlite was called with dataDir and vector extension in strict mode
    expect(PGliteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir: expectedPath,
        extensions: expect.anything(),
      })
    );
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

  it('uses the isolated userData database path for Electron --test-mode runs', async () => {
    process.env['NODE_ENV'] = 'development';
    process.argv = [...originalArgv, '--test-mode'];
    existsSyncMock.mockReturnValue(false);
    appGetPathMock.mockImplementation(((name: string) => `/mock/${name}`) as () => string);

    const { initializeMainDatabase } = await import('../../db-main');
    await initializeMainDatabase();

    const expectedPath = path.join('/mock/userData', 'profiles', 'test', 'pgdata');

    expect(appGetPathMock).toHaveBeenCalledWith('userData');
    expect(mkdirSyncMock).toHaveBeenCalledWith(expectedPath, { recursive: true });
    expect(PGliteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir: expectedPath,
        extensions: expect.anything(),
      })
    );
  });

  it('returns a ready bootstrap report before opening the long-lived database handle', async () => {
    existsSyncMock.mockReturnValue(false);
    appGetPathMock.mockImplementation(((name: string) => `/mock/${name}`) as () => string);

    const { initializeMainDatabaseWithBootstrapReport } = await import('../../db-main');
    const result = await initializeMainDatabaseWithBootstrapReport();

    const expectedDataDir = path.join('/mock/userData', 'profiles', 'test', 'pgdata');
    expect(runPgliteBootstrapCapabilityProbeMock).toHaveBeenCalledWith({
      dataDir: expectedDataDir,
      profileId: 'test',
      runtime: {
        engine: 'pglite',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
    });
    expect(runPgliteBootstrapCapabilityProbeMock.mock.invocationCallOrder[0]).toBeLessThan(
      PGliteMock.mock.invocationCallOrder[0] ?? 0
    );
    expect(result).toEqual({
      bootstrapReport: expect.objectContaining({
        phase: 'ready',
        ready: true,
      }),
      capabilities: { liveQuery: true },
      initialized: true,
    });
    expect(PGliteMock).toHaveBeenCalledTimes(1);
    expect(migrateMock).toHaveBeenCalledTimes(1);
  });

  it('reuses the bootstrap report after successful owner-owned initialization', async () => {
    existsSyncMock.mockReturnValue(true);

    const { initializeMainDatabaseWithBootstrapReport } = await import('../../db-main');
    const first = await initializeMainDatabaseWithBootstrapReport();
    const second = await initializeMainDatabaseWithBootstrapReport();

    expect(second).toEqual(first);
    expect(runPgliteBootstrapCapabilityProbeMock).toHaveBeenCalledTimes(1);
    expect(PGliteMock).toHaveBeenCalledTimes(1);
  });

  it('returns a blocked bootstrap report without opening the long-lived database handle', async () => {
    existsSyncMock.mockReturnValue(true);
    runPgliteBootstrapCapabilityProbeMock.mockResolvedValue(createBlockedBootstrapProbeReport());

    const { initializeMainDatabaseWithBootstrapReport } = await import('../../db-main');
    const result = await initializeMainDatabaseWithBootstrapReport();

    expect(result).toEqual({
      bootstrapReport: expect.objectContaining({
        phase: 'blocked',
        ready: false,
      }),
      capabilities: { liveQuery: true },
      initialized: false,
    });
    expect(PGliteMock).not.toHaveBeenCalled();
    expect(migrateMock).not.toHaveBeenCalled();
  });

  it('initializes Turso owner client and executes simple SQL without opening PGlite', async () => {
    process.env['BRAINSTRIKE_DB_RUNTIME'] = 'turso';
    existsSyncMock.mockReturnValue(false);
    appGetPathMock.mockImplementation(((name: string) => `/mock/${name}`) as () => string);

    const { getDatabase, initializeMainDatabaseWithBootstrapReport } = await import(
      '../../db-main'
    );
    const result = await initializeMainDatabaseWithBootstrapReport();
    const db = await getDatabase();
    const queryResult = await db.query('SELECT ? AS value', ['ok']);

    expect(runTursoProfileBootstrapMock).toHaveBeenCalledWith({
      dbPath: path.join('/mock/userData', 'profiles', 'test', 'turso-primary.db'),
      profileId: 'test',
      runtime: {
        engine: 'turso',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
    });
    expect(createTursoOwnerClientMock).toHaveBeenCalledWith({
      dbPath: path.join('/mock/userData', 'profiles', 'test', 'turso-primary.db'),
    });
    expect(runPgliteBootstrapCapabilityProbeMock).not.toHaveBeenCalled();
    expect(PGliteMock).not.toHaveBeenCalled();
    expect(migrateMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      bootstrapReport: expect.objectContaining({
        ready: true,
        runtime: expect.objectContaining({ engine: 'turso' }),
        search: expect.objectContaining({ ownershipMode: 'split-search-index-store' }),
      }),
      capabilities: { liveQuery: false },
      initialized: true,
    });
    expect(queryResult).toEqual({
      rows: [{ sql: 'SELECT ? AS value', params: ['ok'], value: 'ok' }],
    });
    expect(tursoOwnerQueryMock).toHaveBeenCalledWith('SELECT ? AS value', ['ok']);
  });

  it('getDatabase uses the runtime-aware Turso bootstrap path without explicit pre-initialization', async () => {
    process.env['BRAINSTRIKE_DB_RUNTIME'] = 'turso';
    existsSyncMock.mockReturnValue(false);
    appGetPathMock.mockImplementation(((name: string) => `/mock/${name}`) as () => string);

    const { getDatabase } = await import('../../db-main');
    const db = await getDatabase();
    const queryResult = await db.query('SELECT ? AS value', ['lazy']);

    expect(runTursoProfileBootstrapMock).toHaveBeenCalledWith({
      dbPath: path.join('/mock/userData', 'profiles', 'test', 'turso-primary.db'),
      profileId: 'test',
      runtime: {
        engine: 'turso',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
    });
    expect(createTursoOwnerClientMock).toHaveBeenCalledWith({
      dbPath: path.join('/mock/userData', 'profiles', 'test', 'turso-primary.db'),
    });
    expect(runPgliteBootstrapCapabilityProbeMock).not.toHaveBeenCalled();
    expect(PGliteMock).not.toHaveBeenCalled();
    expect(migrateMock).not.toHaveBeenCalled();
    expect(queryResult).toEqual({
      rows: [{ sql: 'SELECT ? AS value', params: ['lazy'], value: 'ok' }],
    });
  });

  it('coalesces concurrent Turso lazy initialization into one bootstrap and owner handle', async () => {
    process.env['BRAINSTRIKE_DB_RUNTIME'] = 'turso';
    existsSyncMock.mockReturnValue(false);
    appGetPathMock.mockImplementation(((name: string) => `/mock/${name}`) as () => string);
    let releaseBootstrap = () => {};
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    runTursoProfileBootstrapMock.mockImplementation(async () => {
      await bootstrapGate;
      return createReadyTursoProfileBootstrapReport();
    });

    const { getDatabase } = await import('../../db-main');
    const first = getDatabase();
    const second = getDatabase();
    const third = getDatabase();

    releaseBootstrap();
    const [firstDb, secondDb, thirdDb] = await Promise.all([first, second, third]);

    expect(firstDb).toBe(secondDb);
    expect(secondDb).toBe(thirdDb);
    expect(runTursoProfileBootstrapMock).toHaveBeenCalledTimes(1);
    expect(createTursoOwnerClientMock).toHaveBeenCalledTimes(1);
    expect(PGliteMock).not.toHaveBeenCalled();
    expect(migrateMock).not.toHaveBeenCalled();
  });

  it('reports Turso lazy bootstrap as initialization in flight while bootstrap is gated', async () => {
    process.env['BRAINSTRIKE_DB_RUNTIME'] = 'turso';
    existsSyncMock.mockReturnValue(false);
    appGetPathMock.mockImplementation(((name: string) => `/mock/${name}`) as () => string);
    let releaseBootstrap = () => {};
    const bootstrapGate = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    runTursoProfileBootstrapMock.mockImplementation(async () => {
      await bootstrapGate;
      return createReadyTursoProfileBootstrapReport();
    });

    const { getDatabase, getDatabaseDiagnostics } = await import('../../db-main');
    const databasePromise = getDatabase();

    try {
      await vi.waitFor(() => {
        expect(runTursoProfileBootstrapMock).toHaveBeenCalledTimes(1);
      });
      expect(getDatabaseDiagnostics().initializationInFlight).toBe(true);
    } finally {
      releaseBootstrap();
      await databasePromise;
    }

    expect(getDatabaseDiagnostics().initializationInFlight).toBe(false);
    expect(getDatabaseDiagnostics().profileBootstrapReport).toMatchObject({
      phase: 'ready',
      ready: true,
      runtime: { engine: 'turso' },
      search: { ownershipMode: 'split-search-index-store' },
    });
  });

  it('surfaces Turso owner-client QoS diagnostics without reinitializing the owner handle', async () => {
    process.env['BRAINSTRIKE_DB_RUNTIME'] = 'turso';
    existsSyncMock.mockReturnValue(false);
    appGetPathMock.mockImplementation(((name: string) => `/mock/${name}`) as () => string);

    const { getDatabaseDiagnostics, initializeMainDatabaseWithBootstrapReport } = await import(
      '../../db-main'
    );
    await initializeMainDatabaseWithBootstrapReport();

    const firstDiagnostics = getDatabaseDiagnostics();
    const secondDiagnostics = getDatabaseDiagnostics();

    expect(firstDiagnostics).toMatchObject({
      hasDatabaseHandle: true,
      profileBootstrapReport: {
        ready: true,
        runtime: { engine: 'turso' },
      },
      tursoOwnerClientQoS: {
        activeOperation: null,
        available: true,
        queuedOperationCount: 0,
        queuedOperations: [],
        slowQueuedOperationCount: 0,
        slowQueueThresholdMs: 1000,
        totalCompletedOperations: 0,
        totalFailedOperations: 0,
        totalQueuedOperations: 0,
        totalStartedOperations: 0,
      },
    });
    expect(secondDiagnostics.tursoOwnerClientQoS).toEqual(firstDiagnostics.tursoOwnerClientQoS);
    expect(runTursoProfileBootstrapMock).toHaveBeenCalledTimes(1);
    expect(createTursoOwnerClientMock).toHaveBeenCalledTimes(1);
    expect(runPgliteBootstrapCapabilityProbeMock).not.toHaveBeenCalled();
    expect(PGliteMock).not.toHaveBeenCalled();
    expect(migrateMock).not.toHaveBeenCalled();
    expect(tursoOwnerQoSDiagnosticsMock).toHaveBeenCalledTimes(2);
  });

  it('keeps diagnostics available when a Turso owner handle lacks QoS diagnostics', async () => {
    process.env['BRAINSTRIKE_DB_RUNTIME'] = 'turso';
    existsSyncMock.mockReturnValue(false);
    appGetPathMock.mockImplementation(((name: string) => `/mock/${name}`) as () => string);
    createTursoOwnerClientMock.mockResolvedValueOnce({
      close: tursoOwnerCloseMock,
      exec: tursoOwnerExecMock,
      query: tursoOwnerQueryMock,
    });

    const { getDatabaseDiagnostics, initializeMainDatabaseWithBootstrapReport } = await import(
      '../../db-main'
    );
    await initializeMainDatabaseWithBootstrapReport();

    expect(getDatabaseDiagnostics().tursoOwnerClientQoS).toEqual({
      available: false,
      reason: 'diagnostics-unsupported',
    });
    expect(loggerErrorMock).toHaveBeenCalledWith('Turso owner handle is missing getQoSDiagnostics');
  });

  it('does not reacquire the serialized initialization lock during recovery retry', async () => {
    process.env['BRAINSTRIKE_SERIALIZE_PGLITE_INIT'] = '1';
    existsSyncMock.mockReturnValue(true);
    queryMock.mockRejectedValueOnce(new Error('invalid page in block 7'));
    const successfulDb = {
      close: closeMock,
      exec: execMock,
      query: queryMock,
    };
    PGliteMock.mockImplementationOnce(function (this: {
      close: () => Promise<void>;
      query: () => Promise<unknown>;
      exec: () => Promise<void>;
    }) {
      this.close = closeMock;
      this.query = queryMock;
      this.exec = execMock;
    }).mockImplementationOnce(function (this: {
      close: () => Promise<void>;
      query: () => Promise<unknown>;
      exec: () => Promise<void>;
    }) {
      Object.assign(this, successfulDb);
    });

    const { initializeMainDatabaseWithBootstrapReport } = await import('../../db-main');
    const result = await initializeMainDatabaseWithBootstrapReport();
    const second = await initializeMainDatabaseWithBootstrapReport();

    expect(result.initialized).toBe(true);
    expect(second).toEqual(result);
    const serializedLockWrites = writeFileSyncMock.mock.calls.filter(([lockPath]) =>
      String(lockPath).includes('brainstrike-pglite-initialization')
    );
    expect(serializedLockWrites).toHaveLength(1);
    expect(runPgliteBootstrapCapabilityProbeMock).toHaveBeenCalledTimes(1);
    expect(PGliteMock).toHaveBeenCalledTimes(2);
  });

  it('recovers a corrupt bootstrap probe before accepting the owner-owned database handle', async () => {
    existsSyncMock.mockReturnValue(true);
    runPgliteBootstrapCapabilityProbeMock
      .mockResolvedValueOnce(
        createFailedBootstrapProbeReport({
          message: 'invalid page in block 7',
          phase: 'opening-store',
        })
      )
      .mockResolvedValueOnce(createReadyBootstrapProbeReport());

    const { initializeMainDatabaseWithBootstrapReport } = await import('../../db-main');
    const result = await initializeMainDatabaseWithBootstrapReport();

    expect(result).toEqual({
      bootstrapReport: expect.objectContaining({
        phase: 'ready',
        ready: true,
      }),
      capabilities: { liveQuery: true },
      initialized: true,
    });
    expect(runPgliteBootstrapCapabilityProbeMock).toHaveBeenCalledTimes(2);
    expect(rmSyncMock).toHaveBeenCalledWith('/mock/userData/profiles/test', {
      recursive: true,
      force: true,
    });
    expect(PGliteMock).toHaveBeenCalledTimes(1);
  });

  it('does not recover PGlite corruption reported while probing capabilities', async () => {
    existsSyncMock.mockReturnValue(true);
    runPgliteBootstrapCapabilityProbeMock
      .mockResolvedValueOnce(
        createFailedBootstrapProbeReport({
          message: 'invalid page in block 7',
          phase: 'probing-capabilities',
        })
      )
      .mockResolvedValueOnce(createReadyBootstrapProbeReport());

    const { initializeMainDatabaseWithBootstrapReport } = await import('../../db-main');
    const result = await initializeMainDatabaseWithBootstrapReport();

    expect(result).toMatchObject({
      bootstrapReport: {
        phase: 'failed',
        ready: false,
        runtime: { engine: 'pglite' },
      },
      capabilities: { liveQuery: true },
      initialized: false,
    });
    expect(runPgliteBootstrapCapabilityProbeMock).toHaveBeenCalledTimes(1);
    expect(rmSyncMock).not.toHaveBeenCalledWith('/mock/userData/profiles/test', {
      recursive: true,
      force: true,
    });
    expect(PGliteMock).not.toHaveBeenCalled();
  });

  it('recovers a corrupt Turso bootstrap before opening the owner client', async () => {
    process.env['BRAINSTRIKE_DB_RUNTIME'] = 'turso';
    existsSyncMock.mockReturnValue(true);
    runTursoProfileBootstrapMock
      .mockResolvedValueOnce(
        createFailedTursoProfileBootstrapReport({
          message: 'database disk image is malformed',
          phase: 'opening-store',
        })
      )
      .mockResolvedValueOnce(createReadyTursoProfileBootstrapReport());

    const { initializeMainDatabaseWithBootstrapReport } = await import('../../db-main');
    const result = await initializeMainDatabaseWithBootstrapReport();

    expect(result).toEqual({
      bootstrapReport: expect.objectContaining({
        phase: 'ready',
        ready: true,
        runtime: expect.objectContaining({ engine: 'turso' }),
      }),
      capabilities: { liveQuery: false },
      initialized: true,
    });
    expect(runTursoProfileBootstrapMock).toHaveBeenCalledTimes(2);
    expect(rmSyncMock).toHaveBeenCalledWith('/mock/userData/profiles/test', {
      recursive: true,
      force: true,
    });
    expect(mkdirSyncMock).toHaveBeenCalledWith('/mock/userData/profiles/test', {
      recursive: true,
    });
    expect(createTursoOwnerClientMock).toHaveBeenCalledTimes(1);
    expect(createTursoOwnerClientMock).toHaveBeenCalledWith({
      dbPath: path.join('/mock/userData', 'profiles', 'test', 'turso-primary.db'),
    });
    expect(runPgliteBootstrapCapabilityProbeMock).not.toHaveBeenCalled();
    expect(PGliteMock).not.toHaveBeenCalled();
    expect(migrateMock).not.toHaveBeenCalled();
  });

  it('recovers a non-database Turso file before opening the owner client', async () => {
    process.env['BRAINSTRIKE_DB_RUNTIME'] = 'turso';
    existsSyncMock.mockReturnValue(true);
    runTursoProfileBootstrapMock
      .mockResolvedValueOnce(
        createFailedTursoProfileBootstrapReport({
          message: 'file is not a database',
          phase: 'opening-store',
        })
      )
      .mockResolvedValueOnce(createReadyTursoProfileBootstrapReport());

    const { initializeMainDatabaseWithBootstrapReport } = await import('../../db-main');
    const result = await initializeMainDatabaseWithBootstrapReport();

    expect(result.initialized).toBe(true);
    expect(result.bootstrapReport).toMatchObject({
      phase: 'ready',
      ready: true,
      runtime: { engine: 'turso' },
    });
    expect(runTursoProfileBootstrapMock).toHaveBeenCalledTimes(2);
    expect(rmSyncMock).toHaveBeenCalledWith('/mock/userData/profiles/test', {
      recursive: true,
      force: true,
    });
    expect(createTursoOwnerClientMock).toHaveBeenCalledTimes(1);
  });

  it('recovers Turso corruption reported while probing capabilities', async () => {
    process.env['BRAINSTRIKE_DB_RUNTIME'] = 'turso';
    existsSyncMock.mockReturnValue(true);
    runTursoProfileBootstrapMock
      .mockResolvedValueOnce(
        createFailedTursoProfileBootstrapReport({
          message: 'database disk image is malformed',
          phase: 'probing-capabilities',
        })
      )
      .mockResolvedValueOnce(createReadyTursoProfileBootstrapReport());

    const { initializeMainDatabaseWithBootstrapReport } = await import('../../db-main');
    const result = await initializeMainDatabaseWithBootstrapReport();

    expect(result.initialized).toBe(true);
    expect(result.bootstrapReport).toMatchObject({
      phase: 'ready',
      ready: true,
      runtime: { engine: 'turso' },
    });
    expect(runTursoProfileBootstrapMock).toHaveBeenCalledTimes(2);
    expect(rmSyncMock).toHaveBeenCalledWith('/mock/userData/profiles/test', {
      recursive: true,
      force: true,
    });
    expect(createTursoOwnerClientMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the same-boot engine-upgrade backup prune exclusion through owner-owned init', async () => {
    const dataDir = path.join('/mock/userData', 'profiles', 'test', 'pgdata');
    const backupDir = `${dataDir}.pre-pg18-from-pg17.bak`;
    let pgVersionExists = true;
    existsSyncMock.mockImplementation(
      (value: string) => value === dataDir || (value.endsWith('PG_VERSION') && pgVersionExists)
    );
    readFileSyncMock.mockImplementation((value: string) => {
      if (value.endsWith('PG_VERSION')) {
        return '17';
      }
      return '';
    });
    renameSyncMock.mockImplementation(() => {
      pgVersionExists = false;
    });
    readdirSyncMock.mockImplementation((value: string) => {
      if (value === path.dirname(dataDir)) {
        return [path.basename(backupDir)];
      }
      return [];
    });
    statSyncMock.mockReturnValue({
      mtimeMs: 0,
    });

    const { initializeMainDatabaseWithBootstrapReport } = await import('../../db-main');
    await initializeMainDatabaseWithBootstrapReport();

    const backupRemovals = rmSyncMock.mock.calls.filter(
      ([removedPath]) => removedPath === backupDir
    );
    expect(renameSyncMock).toHaveBeenCalledWith(dataDir, backupDir);
    expect(backupRemovals).toHaveLength(1);
  });
});

function createReadyBootstrapProbeReport() {
  const checks = [
    'store.open',
    'schema.migrated',
    'extension.pgvector',
    'extension.pg_trgm',
    'search.fts-grep',
    'capability.transaction',
    'capability.live-query',
    'queue.table',
    'assistant-memory.run-usage',
    'assistant-memory.mastra-schema',
    'workspace-index.system-role',
    'store.close',
  ].map((id) => ({
    id,
    label: id,
    required: id !== 'assistant-memory.mastra-schema',
    status: id === 'assistant-memory.mastra-schema' ? 'skipped' : 'passed',
  }));

  return {
    blockingIssues: [],
    bootstrapReport: {
      checks,
      failure: null,
      phase: 'ready',
      profileId: 'test',
      ready: true,
      runtime: {
        engine: 'pglite',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
      startedAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:01.000Z',
    },
    checks,
    generatedAt: '2026-06-22T00:00:01.000Z',
    reportVersion: 1,
  };
}

function createReadyTursoProfileBootstrapReport() {
  const checks = [
    'store.open',
    'primary-store.mvcc',
    'schema.baseline',
    'search.grep-content-grams',
    'search.ownership',
    'store.close',
  ].map((id) => ({
    id,
    label: id,
    required: true,
    status: 'passed',
  }));

  return {
    blockingIssues: [],
    bootstrapReport: {
      checks,
      failure: null,
      phase: 'ready',
      profileId: 'test',
      ready: true,
      runtime: {
        engine: 'turso',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
      search: {
        indexedSearch: 'available',
        message: 'Primary Turso MVCC store requires an explicitly owned search-index store.',
        ownershipMode: 'split-search-index-store',
      },
      startedAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:01.000Z',
    },
    checks,
    generatedAt: '2026-06-22T00:00:01.000Z',
    reportVersion: 1,
  };
}

function createBlockedBootstrapProbeReport() {
  const readyReport = createReadyBootstrapProbeReport();
  const checks = readyReport.checks.map((check) =>
    check.id === 'queue.table' ? { ...check, status: 'failed' } : check
  );
  return {
    ...readyReport,
    blockingIssues: [
      {
        checkId: 'queue.table',
        message: 'Required bootstrap check failed: queue.table',
        phase: 'blocked',
        severity: 'blocking',
      },
    ],
    bootstrapReport: {
      ...readyReport.bootstrapReport,
      checks,
      phase: 'blocked',
      ready: false,
    },
    checks,
  };
}

function createFailedBootstrapProbeReport(input: {
  readonly message: string;
  readonly phase: 'opening-store' | 'migrating-schema' | 'probing-capabilities';
}) {
  const readyReport = createReadyBootstrapProbeReport();
  const checks = readyReport.checks.map((check) =>
    check.id === 'store.open' ? { ...check, status: 'failed', message: input.message } : check
  );
  return {
    ...readyReport,
    blockingIssues: [
      {
        checkId: 'store.open',
        message: `Bootstrap failed during ${input.phase}: ${input.message}`,
        phase: 'failed',
        severity: 'blocking',
      },
    ],
    bootstrapReport: {
      ...readyReport.bootstrapReport,
      checks,
      failure: {
        code: 'bootstrap_capability_probe_failed',
        message: input.message,
        phase: input.phase,
        timestamp: '2026-06-22T00:00:00.500Z',
      },
      phase: 'failed',
      ready: false,
    },
    checks,
  };
}

function createFailedTursoProfileBootstrapReport(input: {
  readonly message: string;
  readonly phase: 'opening-store' | 'migrating-schema' | 'probing-capabilities';
}) {
  const readyReport = createReadyTursoProfileBootstrapReport();
  const checks = readyReport.checks.map((check) =>
    check.id === 'store.open' ? { ...check, status: 'failed', message: input.message } : check
  );
  return {
    ...readyReport,
    blockingIssues: [
      {
        checkId: 'store.open',
        message: `Bootstrap failed during ${input.phase}: ${input.message}`,
        phase: 'failed',
        severity: 'blocking',
      },
    ],
    bootstrapReport: {
      ...readyReport.bootstrapReport,
      checks,
      failure: {
        code: 'turso_profile_bootstrap_failed',
        message: input.message,
        phase: input.phase,
        timestamp: '2026-06-22T00:00:00.500Z',
      },
      phase: 'failed',
      ready: false,
    },
    checks,
  };
}
