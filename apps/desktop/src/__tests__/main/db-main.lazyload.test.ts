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

// Mock fs and electron app path
const existsSyncMock = vi.fn(() => true);
const mkdirSyncMock = vi.fn();
const openSyncMock = vi.fn(() => 123);
const writeFileSyncMock = vi.fn();
const closeSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const readFileSyncMock = vi.fn(() => '');
const readdirSyncMock = vi.fn(() => []);
const lstatSyncMock = vi.fn(() => ({
  isDirectory: () => false,
  isFile: () => false,
}));
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
  cpSync: vi.fn(),
  rmSync: vi.fn(),
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
  },
}));

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/mock/documents') } }));

const vectorSetupMock = vi.fn(async () => ({
  bundlePath: new URL('file:///mock/vector.tar.gz'),
  emscriptenOpts: {},
}));

vi.mock('@electric-sql/pglite-pgvector', () => ({
  vector: {
    name: 'pgvector',
    setup: vectorSetupMock,
  },
}));

// Mock PGlite + migrate to allow initialization
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
vi.mock('@electric-sql/pglite-pgvector', () => ({ vector: { name: 'vector' } }));
vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  migrate: (...args: unknown[]) => migrateMock(...args),
  resolveBrainstrikeDbRuntimeSelection: vi.fn(() => ({
    bootstrapRuntime: {
      engine: 'pglite',
      host: 'electron-utility',
      persistence: 'filesystem',
    },
    engine: 'pglite',
    platform: 'desktop',
    source: 'default',
  })),
  runPgliteBootstrapCapabilityProbe: vi.fn(() => ({
    blockingIssues: [],
    bootstrapReport: {
      checks: [],
      failure: null,
      phase: 'ready',
      profileId: 'test',
      ready: true,
      runtime: {
        engine: 'pglite',
        host: 'electron-utility',
        persistence: 'filesystem',
      },
      search: {
        indexedSearch: 'available',
        message: 'PGlite owns indexed search.',
        ownershipMode: 'primary-store-indexes',
      },
      startedAt: '2026-06-22T00:00:00.000Z',
      updatedAt: '2026-06-22T00:00:01.000Z',
    },
    checks: [],
    generatedAt: '2026-06-22T00:00:01.000Z',
    reportVersion: 1,
  })),
}));
vi.mock('@brainstrike/utils', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils')>('@brainstrike/utils');
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

describe('db-main lazy-load getDatabase', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installUtilityProcessParentPort();
    process.env['NODE_ENV'] = 'test';
    process.env['BRAINSTRIKE_DB_PROFILE'] = '';
    process.env['BRAINSTRIKE_DB_RUNTIME'] = 'pglite';
    existsSyncMock.mockReturnValue(true);
    mkdirSyncMock.mockImplementation(() => {});
  });

  afterEach(() => {
    restoreParentPort();
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_DB_RUNTIME');
  });

  it('lazy-loads database on first getDatabase call when uninitialized', async () => {
    const { getDatabase } = await import('../../db-main');
    const handle = await getDatabase();
    expect(handle).toBeTruthy();
    // ctor invoked once on first lazy init
    expect(PGliteMock).toHaveBeenCalledTimes(1);
  });

  it('reuses existing database instance when already initialized', async () => {
    const { initializeMainDatabase, getDatabase } = await import('../../db-main');

    const first = await initializeMainDatabase();
    expect(first).toBeTruthy();

    const second = await getDatabase();
    expect(second).toBe(first);
    expect(PGliteMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent getDatabase calls into a single initialization', async () => {
    let releaseQueryGate = () => {};
    const queryGate = new Promise<void>((resolve) => {
      releaseQueryGate = resolve;
    });

    queryMock.mockImplementation(async () => {
      await queryGate;
      return { rows: [{ '?column?': 1 }] };
    });

    const { getDatabase } = await import('../../db-main');

    const first = getDatabase();
    const second = getDatabase();
    const third = getDatabase();

    releaseQueryGate();

    const [db1, db2, db3] = await Promise.all([first, second, third]);
    expect(db1).toBe(db2);
    expect(db2).toBe(db3);
    expect(PGliteMock).toHaveBeenCalledTimes(1);
    expect(migrateMock).toHaveBeenCalledTimes(1);
  });
});
