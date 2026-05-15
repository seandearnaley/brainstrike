import type { IDatabase } from '@brainstrike/db';
import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

const {
  createDatabasePressureControllerMock,
  createEmbeddingCacheRepositoryMock,
  embeddingCacheRepository,
  getDatabaseWorkSchedulerMock,
  scheduler,
  waitForBackgroundPermit,
} = vi.hoisted(() => ({
  createDatabasePressureControllerMock: vi.fn(),
  createEmbeddingCacheRepositoryMock: vi.fn(),
  embeddingCacheRepository: {
    get: vi.fn(),
    getBatch: vi.fn(),
    set: vi.fn(),
    setBatch: vi.fn(),
  },
  getDatabaseWorkSchedulerMock: vi.fn(),
  scheduler: {
    schedule: vi.fn(),
  },
  waitForBackgroundPermit: vi.fn(async () => {}),
}));

vi.mock('@brainstrike/db', () => ({
  createDatabasePressureController: createDatabasePressureControllerMock,
  createEmbeddingCacheRepository: createEmbeddingCacheRepositoryMock,
  getDatabaseWorkScheduler: getDatabaseWorkSchedulerMock,
}));

vi.mock('@brainstrike/embeddings/worker', () => ({
  startEmbeddingWorker: vi.fn(async (_opts) => ({ stop: async () => {} })),
}));

describe('startEmbeddingWorkerWeb', () => {
  it('delegates to startEmbeddingWorker with enable=true', async () => {
    const { startEmbeddingWorker } = await import('@brainstrike/embeddings/worker');
    const { startEmbeddingWorkerWeb } = await import('../embedding-worker-web');
    createEmbeddingCacheRepositoryMock.mockReturnValue(embeddingCacheRepository);
    getDatabaseWorkSchedulerMock.mockReturnValue(scheduler);
    createDatabasePressureControllerMock.mockReturnValue({ waitForBackgroundPermit });

    const db = {
      query: vi.fn(async (): Promise<{ rows: unknown[] }> => ({ rows: [] })),
    } as unknown as IDatabase;
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
    expect(getDatabaseWorkSchedulerMock).toHaveBeenCalledWith(db);
    expect(createDatabasePressureControllerMock).toHaveBeenCalledWith({ scheduler });
  });
});
