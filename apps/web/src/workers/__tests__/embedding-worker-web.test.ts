import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

const { embeddingCacheRepository, createEmbeddingCacheRepositoryMock } = vi.hoisted(() => ({
  embeddingCacheRepository: {
    get: vi.fn(),
    getBatch: vi.fn(),
    set: vi.fn(),
    setBatch: vi.fn(),
  },
  createEmbeddingCacheRepositoryMock: vi.fn(),
}));

vi.mock('@brainstrike/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/db')>();
  return {
    ...actual,
    createEmbeddingCacheRepository: createEmbeddingCacheRepositoryMock,
  };
});

vi.mock('@brainstrike/embeddings/worker', () => ({
  startEmbeddingWorker: vi.fn(async (_opts) => ({ stop: async () => {} })),
}));

describe('startEmbeddingWorkerWeb', () => {
  it('delegates to startEmbeddingWorker with enable=true', async () => {
    const { startEmbeddingWorker } = await import('@brainstrike/embeddings/worker');
    const { createDatabaseWorkScheduler, createScheduledDbHandle } = await import(
      '@brainstrike/db'
    );
    const { startEmbeddingWorkerWeb } = await import('../embedding-worker-web');
    createEmbeddingCacheRepositoryMock.mockReturnValue(embeddingCacheRepository);

    const db = createScheduledDbHandle(
      { query: vi.fn(async () => ({ rows: [] })) },
      createDatabaseWorkScheduler({ foregroundQuietMs: 0 }),
      'background'
    );
    const controller = await startEmbeddingWorkerWeb(db);
    expect(controller).toBeTruthy();
    expect(startEmbeddingWorker).toHaveBeenCalled();
    const args = (startEmbeddingWorker as Mock).mock.calls[0]?.[0];
    expect(args.enable).toBe(true);
    expect(args.db).toBe(db);
    expect(args.embeddingCache).toBe(embeddingCacheRepository);
    expect(args.streamingWorkerUrl).toEqual(expect.any(String));
    expect(args.waitForBackgroundPermit).toEqual(expect.any(Function));
    expect(createEmbeddingCacheRepositoryMock).toHaveBeenCalledWith(db);
  });
});
