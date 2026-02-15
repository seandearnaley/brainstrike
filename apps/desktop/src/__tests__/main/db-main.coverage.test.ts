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

  it('resetLocalDatabase completes without throwing', async () => {
    const { resetLocalDatabase } = await import('../../db-main');
    await expect(resetLocalDatabase()).resolves.toBeUndefined();
  });
});
