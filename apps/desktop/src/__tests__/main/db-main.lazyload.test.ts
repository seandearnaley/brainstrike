import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs and electron app path
const existsSyncMock = vi.fn(() => true);
const mkdirSyncMock = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  default: { existsSync: existsSyncMock, mkdirSync: mkdirSyncMock },
}));

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/mock/documents') } }));

const vectorSetupMock = vi.fn(async () => ({
  bundlePath: new URL('file:///mock/vector.tar.gz'),
  emscriptenOpts: {},
}));

vi.mock('@electric-sql/pglite/vector', () => ({
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
vi.mock('@electric-sql/pglite/vector', () => ({ vector: { name: 'vector' } }));
vi.mock('@brainstrike/db', () => ({ migrate: (...args: unknown[]) => migrateMock(...args) }));
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
    process.env['NODE_ENV'] = 'test';
    existsSyncMock.mockReturnValue(true);
    mkdirSyncMock.mockImplementation(() => undefined);
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
});
