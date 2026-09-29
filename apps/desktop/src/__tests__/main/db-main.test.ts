import path from 'node:path';
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
vi.mock('@electric-sql/pglite', () => ({
  PGlite: { create: (options: unknown) => Promise.resolve(new PGliteMock(options)) },
}));
vi.mock('@electric-sql/pglite-pgvector', () => ({ vector: { name: 'vector' } }));
vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  migrate: migrateMock,
  rebuildCrashSensitiveIndexes: vi.fn(async () => ({ rebuilt: [], totalDurationMs: 0 })),
}));
vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  migrate: migrateMock,
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

describe('initializeMainDatabase', () => {
  const originalArgv = [...process.argv];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installUtilityProcessParentPort();
    process.env['NODE_ENV'] = 'test';
    // The utility-process host receives both fields from main; it derives nothing.
    process.env['BRAINSTRIKE_DB_ROOT_PATH'] = '/mock/db-root';
    process.env['BRAINSTRIKE_DB_PROFILE'] = 'host-profile';
    process.argv = [...originalArgv];
  });

  afterEach(() => {
    restoreParentPort();
    process.argv = [...originalArgv];
  });

  it('creates directory, migrates, and returns singleton instance', async () => {
    existsSyncMock.mockReturnValue(false);

    const { initializeMainDatabase } = await import('../../db-main');
    const db1 = await initializeMainDatabase();

    const expectedPath = path.join('/mock/db-root', 'profiles', 'host-profile', 'pgdata');

    expect(appGetPathMock).not.toHaveBeenCalled();
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

  it('uses the injected location even when the host sees --test-mode or a development NODE_ENV', async () => {
    process.env['NODE_ENV'] = 'development';
    process.argv = [...originalArgv, '--test-mode'];
    existsSyncMock.mockReturnValue(false);

    const { initializeMainDatabase } = await import('../../db-main');
    await initializeMainDatabase();

    const expectedPath = path.join('/mock/db-root', 'profiles', 'host-profile', 'pgdata');

    expect(appGetPathMock).not.toHaveBeenCalled();
    expect(mkdirSyncMock).toHaveBeenCalledWith(expectedPath, { recursive: true });
    expect(PGliteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir: expectedPath,
        extensions: expect.anything(),
      })
    );
  });
});
