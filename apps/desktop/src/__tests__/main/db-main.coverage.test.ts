import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
  },
}));

// Mock fs utils to avoid touching real filesystem
vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>();
  const mocks = {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    cpSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    openSync: vi.fn(() => 123),
    writeFileSync: vi.fn(),
    closeSync: vi.fn(),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    lstatSync: vi.fn(() => ({
      isDirectory: () => false,
      isFile: () => false,
    })),
  };
  return {
    ...mod,
    ...mocks,
    default: { ...mod.default, ...mocks },
  };
});

describe('db-main coverage helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env['NODE_ENV'] = 'test';
    process.env['BRAINSTRIKE_DB_PROFILE'] = '';
    vi.doMock('@electric-sql/pglite/vector', () => ({ vector: { name: 'vector' } }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('fails fast when pgvector extension cannot be loaded', async () => {
    vi.doMock('@electric-sql/pglite/vector', () => {
      throw new Error('vector module missing');
    });
    const { initializeMainDatabase, getDatabaseDiagnostics } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(/pgvector extension is required/i);
    const diagnostics = getDatabaseDiagnostics();
    expect(diagnostics.initializationAttemptCount).toBeGreaterThan(0);
    expect(diagnostics.lastInitializationFailure?.category).toBe('missing-extension');
    expect(diagnostics.lastInitializationFailure?.stage).toBe('load-extensions');
  });

  it('classifies wasm abort during extension load as wasm-runtime', async () => {
    vi.doMock('@electric-sql/pglite/vector', () => {
      return {
        get vector() {
          throw new Error('Aborted(). Build with -sASSERTIONS for more info.');
        },
      };
    });
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
