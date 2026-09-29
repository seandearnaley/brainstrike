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

const fsMocks = vi.hoisted(() => ({
  closeSync: vi.fn(),
  cpSync: vi.fn(),
  existsSync: vi.fn(() => true),
  fsyncSync: vi.fn(),
  lstatSync: vi.fn(() => ({
    isDirectory: () => false,
    isFile: () => false,
  })),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 123),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => ''),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>();
  return {
    ...mod,
    ...fsMocks,
    default: { ...mod, ...fsMocks },
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
  },
}));

function mockSuccessfulDatabaseModules(options?: {
  liveModule?: unknown;
  pgTextsearchModule?: unknown;
  pgTrgmModule?: unknown;
  vectorModule?: unknown;
}): { PGliteMock: ReturnType<typeof vi.fn> } {
  const queryMock = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    .mockResolvedValueOnce({ rows: [{ extname: 'vector' }] });
  const execMock = vi.fn().mockResolvedValue(undefined);
  const syncToFsMock = vi.fn().mockResolvedValue(undefined);
  const PGliteMock = vi.fn().mockImplementation(function (this: {
    exec: typeof execMock;
    query: typeof queryMock;
    syncToFs: typeof syncToFsMock;
  }) {
    this.query = queryMock;
    this.exec = execMock;
    this.syncToFs = syncToFsMock;
  });

  vi.doMock('@electric-sql/pglite', () => ({
    PGlite: { create: (options: unknown) => Promise.resolve(new PGliteMock(options)) },
  }));
  vi.doMock('@brainstrike/db', () => ({ migrate: vi.fn().mockResolvedValue(undefined) }));
  vi.doMock('@electric-sql/pglite-pgvector', () => options?.vectorModule ?? { vector: 'vector' });
  vi.doMock('@electric-sql/pglite/live', () => options?.liveModule ?? { live: 'live' });
  vi.doMock(
    '@electric-sql/pglite/contrib/pg_trgm',
    () => options?.pgTrgmModule ?? { pg_trgm: 'pg_trgm' }
  );
  vi.doMock(
    '@electric-sql/pglite-pg_textsearch',
    () => options?.pgTextsearchModule ?? { pg_textsearch: 'pg_textsearch' }
  );

  return { PGliteMock };
}

describe('db-main coverage helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('@brainstrike/db');
    vi.doUnmock('@brainstrike/db/pglite-factory');
    vi.doUnmock('@electric-sql/pglite');
    vi.doUnmock('@electric-sql/pglite-pgvector');
    vi.doUnmock('@electric-sql/pglite/live');
    vi.doUnmock('@electric-sql/pglite/contrib/pg_trgm');
    vi.doUnmock('@electric-sql/pglite-pg_textsearch');
    installUtilityProcessParentPort();
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.mkdirSync.mockReset();
    fsMocks.rmSync.mockReset();
    fsMocks.cpSync.mockReset();
    fsMocks.readdirSync.mockReturnValue([]);
    fsMocks.openSync.mockReturnValue(123);
    fsMocks.writeFileSync.mockReset();
    fsMocks.closeSync.mockReset();
    fsMocks.unlinkSync.mockReset();
    fsMocks.readFileSync.mockReturnValue('');
    fsMocks.lstatSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => false,
    });
    process.env['NODE_ENV'] = 'test';
    process.env['BRAINSTRIKE_DB_PROFILE'] = '';
  });

  afterEach(() => {
    vi.resetModules();
    restoreParentPort();
  });

  it('fails fast when pgvector extension cannot be loaded', async () => {
    vi.doMock('@brainstrike/db/pglite-factory', () => ({
      get createBrainstrikePglite() {
        throw new Error('vector module missing');
      },
    }));

    const { initializeMainDatabase, getDatabaseDiagnostics } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(/vector module missing/i);
    const diagnostics = getDatabaseDiagnostics();
    expect(diagnostics.initializationAttemptCount).toBeGreaterThan(0);
    expect(diagnostics.lastInitializationFailure?.category).toBe('missing-extension');
    expect(diagnostics.lastInitializationFailure?.stage).toBe('load-extensions');
  });

  it('loads the canonical engine and client extension sets through the factory', async () => {
    const { PGliteMock } = mockSuccessfulDatabaseModules();

    const { initializeMainDatabase } = await import('../../db-main');
    await initializeMainDatabase();

    expect(PGliteMock).toHaveBeenCalledWith({
      dataDir: expect.stringContaining('pgdata'),
      extensions: {
        live: 'live',
        pg_textsearch: 'pg_textsearch',
        pg_trgm: 'pg_trgm',
        vector: 'vector',
      },
    });
  });

  it('fails fast when live query extension cannot be loaded', async () => {
    mockSuccessfulDatabaseModules({ liveModule: {} });

    const { initializeMainDatabase, getDatabaseDiagnostics } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(/No "live" export/i);

    const diagnostics = getDatabaseDiagnostics();
    expect(diagnostics.lastInitializationFailure?.category).toBe('missing-extension');
    expect(diagnostics.lastInitializationFailure?.stage).toBe('load-extensions');
  });

  it('fails fast when pg_trgm extension cannot be loaded', async () => {
    mockSuccessfulDatabaseModules({ pgTrgmModule: {} });

    const { initializeMainDatabase, getDatabaseDiagnostics } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(/No "pg_trgm" export/i);

    const diagnostics = getDatabaseDiagnostics();
    expect(diagnostics.lastInitializationFailure?.category).toBe('missing-extension');
    expect(diagnostics.lastInitializationFailure?.stage).toBe('load-extensions');
  });

  it('fails fast when pg_textsearch extension cannot be loaded', async () => {
    mockSuccessfulDatabaseModules({ pgTextsearchModule: {} });

    const { initializeMainDatabase, getDatabaseDiagnostics } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(/No "pg_textsearch" export/i);

    const diagnostics = getDatabaseDiagnostics();
    expect(diagnostics.lastInitializationFailure?.category).toBe('missing-extension');
    expect(diagnostics.lastInitializationFailure?.stage).toBe('load-extensions');
  });

  it('formats open-database missing-extension failures with the generic message', async () => {
    const { PGliteMock } = mockSuccessfulDatabaseModules();
    PGliteMock.mockImplementation(() => {
      throw new Error('vector export missing from setup');
    });

    const { initializeMainDatabase } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(
      /A required PGlite extension failed to initialize/
    );
  });

  it('serializes non-error extension load failures in diagnostics', async () => {
    const circularFailure: Record<string, unknown> = { code: 'E_BROKEN', reason: 'bad package' };
    circularFailure['self'] = circularFailure;
    vi.doMock('@brainstrike/db/pglite-factory', () => ({
      get createBrainstrikePglite() {
        throw circularFailure;
      },
    }));

    const { initializeMainDatabase } = await import('../../db-main');

    await expect(initializeMainDatabase()).rejects.toThrow(/"self":"\[Circular\]"/);
  });

  it('classifies wasm abort during extension load as wasm-runtime', async () => {
    vi.doMock('@brainstrike/db/pglite-factory', () => ({
      get createBrainstrikePglite() {
        throw new Error('Aborted(). Build with -sASSERTIONS for more info.');
      },
    }));
    const { initializeMainDatabase, getDatabaseDiagnostics } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(/aborted/i);
    const diagnostics = getDatabaseDiagnostics();
    expect(diagnostics.lastInitializationFailure?.category).toBe('wasm-runtime');
    expect(diagnostics.lastInitializationFailure?.stage).toBe('load-extensions');
  });

  it('resetLocalDatabase completes without throwing', async () => {
    const { resetLocalDatabase } = await import('../../db-main');
    await expect(resetLocalDatabase()).resolves.toBeUndefined();
  });
});
