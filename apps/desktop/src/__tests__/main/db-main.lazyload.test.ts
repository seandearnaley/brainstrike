import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');

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
  closeSync: closeSyncMock,
  cpSync: vi.fn(),
  default: {
    closeSync: closeSyncMock,
    existsSync: existsSyncMock,
    fsyncSync: vi.fn(),
    lstatSync: lstatSyncMock,
    mkdirSync: mkdirSyncMock,
    openSync: openSyncMock,
    readdirSync: readdirSyncMock,
    readFileSync: readFileSyncMock,
    unlinkSync: unlinkSyncMock,
    writeFileSync: writeFileSyncMock,
  },
  existsSync: existsSyncMock,
  fsyncSync: vi.fn(),
  lstatSync: lstatSyncMock,
  mkdirSync: mkdirSyncMock,
  openSync: openSyncMock,
  readdirSync: readdirSyncMock,
  readFileSync: readFileSyncMock,
  rmSync: vi.fn(),
  unlinkSync: unlinkSyncMock,
  writeFileSync: writeFileSyncMock,
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

vi.mock('@electric-sql/pglite', () => ({
  PGlite: { create: (options: unknown) => Promise.resolve(new PGliteMock(options)) },
}));
vi.mock('@electric-sql/pglite-pgvector', () => ({ vector: { name: 'vector' } }));
vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  migrate: (...args: unknown[]) => migrateMock(...args),
  rebuildCrashSensitiveIndexes: vi.fn(async () => ({ rebuilt: [], totalDurationMs: 0 })),
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
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  };
});

describe('db-main lazy-load getDatabase', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installUtilityProcessParentPort();
    process.env['NODE_ENV'] = 'test';
    process.env['BRAINSTRIKE_DB_ROOT_PATH'] = '/mock/documents';
    process.env['BRAINSTRIKE_DB_PROFILE'] = 'test';
    existsSyncMock.mockReturnValue(true);
    mkdirSyncMock.mockImplementation(() => {});
  });

  afterEach(() => {
    restoreParentPort();
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
