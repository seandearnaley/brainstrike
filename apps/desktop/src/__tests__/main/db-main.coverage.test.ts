import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
  },
}));

// Mock fs utils to avoid touching real filesystem
vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>();
  return {
    ...mod,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
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
    const { initializeMainDatabase } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(/pgvector extension is required/i);
  });

  it('resetLocalDatabase completes without throwing', async () => {
    const { resetLocalDatabase } = await import('../../db-main');
    await expect(resetLocalDatabase()).resolves.toBeUndefined();
  });
});
