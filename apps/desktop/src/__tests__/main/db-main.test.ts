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
vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  migrate: migrateMock,
}));

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

describe('initializeMainDatabase', () => {
  const originalArgv = [...process.argv];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installUtilityProcessParentPort();
    process.env['NODE_ENV'] = 'test';
    process.env['BRAINSTRIKE_DB_PROFILE'] = '';
    process.argv = [...originalArgv];
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
});
