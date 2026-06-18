import type { IDatabase } from '@brainstrike/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runWorkspaceIndexStageBenchmark } from '../workspace-index-debug-benchmark';

const { completeEmbeddingChunkBatchMock, jobQueueConstructorMock } = vi.hoisted(() => ({
  completeEmbeddingChunkBatchMock: vi.fn(),
  jobQueueConstructorMock: vi.fn(),
}));

vi.mock('@brainstrike/db', () => ({
  JobQueue: vi.fn(function MockJobQueue(db: unknown) {
    jobQueueConstructorMock(db);
    return {
      completeEmbeddingChunkBatch: completeEmbeddingChunkBatchMock,
    };
  }),
}));

describe('runWorkspaceIndexStageBenchmark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('measures DB completion through the production JobQueue batch completion path', async () => {
    completeEmbeddingChunkBatchMock.mockResolvedValueOnce([{ id: 'job-0' }, { id: 'job-1' }]);
    const txQueryMock = vi.fn(async () => ({ rows: [] }));
    const transactionSpy = vi.fn();
    const transaction = async <T>(fn: (tx: IDatabase) => Promise<T>): Promise<T> => {
      transactionSpy(fn);
      return await fn({ query: txQueryMock } as unknown as IDatabase);
    };

    const result = await runWorkspaceIndexStageBenchmark({
      db: {
        query: vi.fn(async () => ({ rows: [] })),
        transaction,
      },
      request: {
        chunkCount: 2,
        dimensions: 4,
        mode: 'db-completion-ceiling',
      },
      timing: {
        nowIso: () => '2026-06-17T04:00:00.000Z',
        nowMs: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125),
      },
    });

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(jobQueueConstructorMock).toHaveBeenCalledWith({ query: txQueryMock });
    expect(completeEmbeddingChunkBatchMock).toHaveBeenCalledWith([
      expect.objectContaining({
        chunkId: expect.stringContaining('chunk-0'),
        embedding: [0.001, 0.002, 0.003, 0.004],
        embeddingSetId: expect.stringContaining('embedding-set'),
        id: expect.stringContaining('job-0'),
        leaseToken: expect.stringContaining('lease-0'),
      }),
      expect.objectContaining({
        chunkId: expect.stringContaining('chunk-1'),
        embedding: [0.001, 0.002, 0.003, 0.004],
        embeddingSetId: expect.stringContaining('embedding-set'),
        id: expect.stringContaining('job-1'),
        leaseToken: expect.stringContaining('lease-1'),
      }),
    ]);
    expect(txQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO embedding_sets'),
      expect.any(Array)
    );
    expect(txQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO roots'),
      expect.any(Array)
    );
    expect(txQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO file_records'),
      expect.any(Array)
    );
    expect(txQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO file_chunks'),
      expect.any(Array)
    );
    expect(txQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO job_queue'),
      expect.any(Array)
    );
    expect(txQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM roots'),
      expect.any(Array)
    );
    expect(result).toMatchObject({
      chunkCount: 2,
      chunksPerSecond: 80,
      completedChunkCount: 2,
      dimensions: 4,
      elapsedMs: 25,
      mode: 'db-completion-ceiling',
    });
  });

  it('throws instead of silently degrading when the DB completion benchmark lacks transactions', async () => {
    await expect(
      runWorkspaceIndexStageBenchmark({
        db: {
          query: vi.fn(async () => ({ rows: [] })),
        },
        request: {
          mode: 'db-completion-ceiling',
        },
      })
    ).rejects.toThrow(
      "Workspace Index benchmark mode 'db-completion-ceiling' requires transactional database support."
    );
  });

  it('runs the DB completion benchmark through the Electron statement-list transaction bridge', async () => {
    const runTransactionMock = vi.fn(
      async (
        _statements: Array<{ params?: unknown[]; sql: string }>,
        _resultIndex: number,
        _options?: unknown
      ): Promise<{ rows?: unknown[] }> => ({
        rows: [{ id: 'job-0' }, { id: 'job-1' }],
      })
    );

    const result = await runWorkspaceIndexStageBenchmark({
      db: null,
      electronRunTransaction: runTransactionMock,
      electronTransactionOptions: { priority: 'background' },
      request: {
        chunkCount: 2,
        dimensions: 4,
        mode: 'db-completion-ceiling',
      },
      timing: {
        nowIso: () => '2026-06-17T04:00:00.000Z',
        nowMs: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(150),
      },
    });

    expect(jobQueueConstructorMock).not.toHaveBeenCalled();
    expect(runTransactionMock).toHaveBeenCalledTimes(1);
    const [statements, resultIndex, options] = runTransactionMock.mock.calls[0] ?? [];
    expect(resultIndex).toBe(5);
    expect(options).toEqual({ priority: 'background' });
    expect(statements).toHaveLength(9);
    expect(statements?.[5]?.sql).toContain('UPDATE file_chunks AS fc');
    expect(statements?.[5]?.sql).toContain('UPDATE job_queue AS j');
    expect(statements?.[6]?.sql).toContain('DELETE FROM job_queue');
    expect(result).toMatchObject({
      chunkCount: 2,
      chunksPerSecond: 40,
      completedChunkCount: 2,
      dimensions: 4,
      elapsedMs: 50,
      mode: 'db-completion-ceiling',
    });
  });
});
