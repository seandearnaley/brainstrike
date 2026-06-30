import { describe, expect, it, vi } from 'vitest';
import { createDesktopTursoEmbeddingWorkerStorage } from '../../../renderer/components/desktop-turso-embedding-worker-storage';

const { createTursoEmbeddingWorkerStorageMock } = vi.hoisted(() => ({
  createTursoEmbeddingWorkerStorageMock: vi.fn(() => ({
    assertEmbeddingStorageReady: vi.fn(),
    createStatsRefreshController: vi.fn(() => {
      throw new Error('Base Turso stats controller should not be used by desktop storage.');
    }),
    getModelConfig: vi.fn(),
    loadChunksByIds: vi.fn(),
    queue: {
      claimMany: vi.fn(() => {
        throw new Error('Base Turso queue should not be used by desktop storage.');
      }),
      completeBatch: vi.fn(),
      completeEmbeddingChunkBatch: vi.fn(),
      fail: vi.fn(),
      failBatch: vi.fn(),
      heartbeatBatch: vi.fn(),
    },
    resolveEmbeddingSetDimension: vi.fn(),
  })),
}));

vi.mock('@brainstrike/embeddings/worker', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/embeddings/worker')>(
    '@brainstrike/embeddings/worker'
  );
  return {
    ...actual,
    createTursoEmbeddingWorkerStorage: createTursoEmbeddingWorkerStorageMock,
  };
});

describe('createDesktopTursoEmbeddingWorkerStorage', () => {
  it('routes Turso queue and stats writes through the Electron bridge', async () => {
    const queueBridge = vi.fn(async (operation: string) =>
      operation === 'claimMany' ? [{ id: 'job-1', lease_token: 'lease-1' }] : []
    );
    const statsBridge = vi.fn(async () => undefined);
    Object.assign(window.electronAPI, {
      db: {
        ...window.electronAPI.db,
        tursoEmbeddingWorkerQueue: queueBridge,
        tursoEmbeddingWorkerStats: statsBridge,
      },
    });

    const storage = createDesktopTursoEmbeddingWorkerStorage({ query: vi.fn() } as never);

    await expect(
      storage.queue.claimMany({
        leaseMs: 60_000,
        limit: 2,
        queue: 'embeddings',
        workerId: 'worker-1',
      })
    ).resolves.toEqual([{ id: 'job-1', lease_token: 'lease-1' }]);
    expect(queueBridge).toHaveBeenCalledWith(
      'claimMany',
      {
        leaseMs: 60_000,
        limit: 2,
        queue: 'embeddings',
        workerId: 'worker-1',
      },
      expect.objectContaining({
        label: 'turso.embedding-worker.queue.claimMany',
        priority: 'background',
      })
    );

    const controller = storage.createStatsRefreshController({
      completedChunkThreshold: 1,
      log: vi.fn(),
      minIntervalMs: 60_000,
      now: vi.fn(() => 0),
    });
    await controller.recordCompletions(['embedding-set-1'], 1);
    await controller.flushIfDue();

    expect(statsBridge).toHaveBeenCalledWith(
      'markDirty',
      ['embedding-set-1'],
      expect.objectContaining({
        label: 'turso.embedding-worker.stats.markDirty',
        priority: 'background',
      })
    );
    expect(statsBridge).toHaveBeenCalledWith(
      'refresh',
      ['embedding-set-1'],
      expect.objectContaining({
        label: 'turso.embedding-worker.stats.refresh',
        priority: 'background',
      })
    );
    expect(createTursoEmbeddingWorkerStorageMock).toHaveBeenCalledWith({
      query: expect.any(Function),
    });
  });
});
