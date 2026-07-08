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
  WORKSPACE_INDEX_EMBEDDING_SET_DEFAULTS: {
    dimensions: 384,
    modelId: 'Xenova/all-MiniLM-L6-v2',
    modelKey: 'local::Xenova/all-MiniLM-L6-v2',
  },
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

  it('measures chunking through the chunking host batch bridge', async () => {
    const chunkBatchMock = vi.fn(async (_request: unknown) => [
      {
        chunks: [{ content: 'first chunk' }, { content: 'second chunk' }],
        skipped: false,
      },
      {
        chunks: [{ content: 'third chunk' }],
        skipped: false,
      },
    ]);

    const result = await runWorkspaceIndexStageBenchmark({
      chunkingHost: {
        chunkBatch: chunkBatchMock,
      },
      request: {
        chunkCount: 2,
        mode: 'chunking-ceiling',
      },
      timing: {
        nowIso: () => '2026-06-17T04:00:00.000Z',
        nowMs: vi.fn().mockReturnValueOnce(200).mockReturnValueOnce(230),
      },
    });

    expect(chunkBatchMock).toHaveBeenCalledTimes(1);
    const request = chunkBatchMock.mock.calls[0]?.[0] as
      | {
          files: readonly unknown[];
        }
      | undefined;
    expect(request).toMatchObject({
      kind: 'chunk-batch',
      options: {
        allowLargeFiles: true,
        forceStrategy: true,
        ignoreFileTypeRecommendations: true,
        requestedStrategy: 'recursive',
        tokenTrueSizing: true,
      },
      requestId: expect.stringContaining('workspace-index-stage-chunking-ceiling'),
    });
    expect(request?.files).toHaveLength(2);
    expect(request?.files[0]).toMatchObject({
      content: expect.stringContaining('Workspace Index chunking ceiling synthetic file 0'),
      fileName: 'chunking-ceiling-0.md',
      filePath: '/__brainstrike_debug__/chunking-ceiling-0.md',
      fileRecordId: expect.stringContaining('file-0'),
    });
    expect(result).toMatchObject({
      chunkCount: 2,
      chunksPerSecond: 100,
      completedChunkCount: 3,
      dimensions: 0,
      elapsedMs: 30,
      mode: 'chunking-ceiling',
    });
  });

  it('throws instead of silently degrading when the chunking benchmark lacks the host bridge', async () => {
    await expect(
      runWorkspaceIndexStageBenchmark({
        request: {
          mode: 'chunking-ceiling',
        },
      })
    ).rejects.toThrow(
      "Workspace Index benchmark mode 'chunking-ceiling' requires the hidden chunking host bridge."
    );
  });

  it('measures managed-cache import without chunking or embedding work', async () => {
    const txQueryMock = vi.fn(async () => ({ rows: [] }));
    const transactionSpy = vi.fn();
    const transaction = async <T>(fn: (tx: IDatabase) => Promise<T>): Promise<T> => {
      transactionSpy(fn);
      return await fn({ query: txQueryMock } as unknown as IDatabase);
    };
    const applyManagedCacheBatchMock = vi.fn(async () => undefined);

    const result = await runWorkspaceIndexStageBenchmark({
      applyManagedCacheBatch: applyManagedCacheBatchMock,
      db: {
        query: vi.fn(async () => ({ rows: [] })),
        transaction,
      },
      request: {
        chunkCount: 2,
        mode: 'import-ceiling',
      },
      timing: {
        nowIso: () => '2026-06-17T04:00:00.000Z',
        nowMs: vi.fn().mockReturnValueOnce(400).mockReturnValueOnce(425),
      },
    });

    expect(transactionSpy).toHaveBeenCalledTimes(2);
    expect(txQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO embedding_sets'),
      expect.any(Array)
    );
    expect(txQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO roots'),
      expect.any(Array)
    );
    expect(txQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM roots'),
      expect.any(Array)
    );
    expect(txQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM collection_indexing_stats'),
      expect.any(Array)
    );
    expect(applyManagedCacheBatchMock).toHaveBeenCalledTimes(1);
    expect(applyManagedCacheBatchMock).toHaveBeenCalledWith({
      changes: [
        expect.objectContaining({
          mode: 'import',
          record: expect.objectContaining({
            content: expect.stringContaining('Workspace Index import ceiling synthetic file 0'),
            path: 'import-ceiling-0.md',
          }),
        }),
        expect.objectContaining({
          mode: 'import',
          record: expect.objectContaining({
            content: expect.stringContaining('Workspace Index import ceiling synthetic file 1'),
            path: 'import-ceiling-1.md',
          }),
        }),
      ],
      embeddingSetId: expect.stringContaining('workspace-index-stage-import-ceiling'),
      rootId: expect.stringContaining('workspace-index-stage-import-ceiling'),
    });
    expect(result).toMatchObject({
      chunkCount: 2,
      chunksPerSecond: 80,
      completedChunkCount: 2,
      dimensions: 0,
      elapsedMs: 25,
      mode: 'import-ceiling',
    });
  });

  it('sets up and cleans import benchmark rows through the Electron transaction bridge', async () => {
    const runTransactionMock = vi.fn<
      (
        statements: Array<{ params?: unknown[]; sql: string }>,
        resultIndex: number,
        options?: unknown
      ) => Promise<{ rows?: unknown[] }>
    >(async () => ({ rows: [] }));
    const applyManagedCacheBatchMock = vi.fn(async () => undefined);

    const result = await runWorkspaceIndexStageBenchmark({
      applyManagedCacheBatch: applyManagedCacheBatchMock,
      db: null,
      electronRunTransaction: runTransactionMock,
      electronTransactionOptions: { priority: 'background' },
      request: {
        chunkCount: 2,
        mode: 'import-ceiling',
      },
      timing: {
        nowIso: () => '2026-06-17T04:00:00.000Z',
        nowMs: vi.fn().mockReturnValueOnce(500).mockReturnValueOnce(550),
      },
    });

    expect(runTransactionMock).toHaveBeenCalledTimes(2);
    expect(runTransactionMock.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sql: expect.stringContaining('INSERT INTO embedding_sets') }),
        expect.objectContaining({ sql: expect.stringContaining('INSERT INTO roots') }),
      ])
    );
    expect(runTransactionMock.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sql: expect.stringContaining('DELETE FROM roots') }),
        expect.objectContaining({
          sql: expect.stringContaining('DELETE FROM collection_indexing_stats'),
        }),
        expect.objectContaining({ sql: expect.stringContaining('DELETE FROM embedding_sets') }),
      ])
    );
    expect(runTransactionMock.mock.calls[0]?.[2]).toEqual({ priority: 'background' });
    expect(runTransactionMock.mock.calls[1]?.[2]).toEqual({ priority: 'background' });
    expect(applyManagedCacheBatchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      chunkCount: 2,
      chunksPerSecond: 40,
      completedChunkCount: 2,
      dimensions: 0,
      elapsedMs: 50,
      mode: 'import-ceiling',
    });
  });

  it('throws instead of silently degrading when import benchmark lacks managed-cache apply', async () => {
    await expect(
      runWorkspaceIndexStageBenchmark({
        db: {
          query: vi.fn(async () => ({ rows: [] })),
          transaction: async <T>(fn: (tx: IDatabase) => Promise<T>): Promise<T> =>
            await fn({ query: vi.fn(async () => ({ rows: [] })) } as unknown as IDatabase),
        },
        request: {
          mode: 'import-ceiling',
        },
      })
    ).rejects.toThrow(
      "Workspace Index benchmark mode 'import-ceiling' requires managed-cache apply support."
    );
  });

  it('measures embedding through the hidden embedding host bridge and validates WebGPU metadata', async () => {
    const queryEmbeddingMock = vi.fn(async () => [0.1, 0.2, 0.3, 0.4]);
    const getStatusMock = vi.fn(async () => ({
      embeddingRuntime: {
        actualWorkerMetadata: {
          device: 'webgpu',
          dtype: 'fp32',
          fallbackApplied: false,
        },
        backendMismatch: false,
        selectedDevicePreference: 'webgpu',
      },
    }));

    const result = await runWorkspaceIndexStageBenchmark({
      embeddingHost: {
        getStatus: getStatusMock,
        queryEmbedding: queryEmbeddingMock,
      },
      request: {
        chunkCount: 2,
        dimensions: 4,
        mode: 'embedding-ceiling',
      },
      timing: {
        nowIso: () => '2026-06-17T04:00:00.000Z',
        nowMs: vi.fn().mockReturnValueOnce(300).mockReturnValueOnce(340),
      },
    });

    expect(queryEmbeddingMock).toHaveBeenCalledTimes(2);
    expect(queryEmbeddingMock).toHaveBeenCalledWith({
      dimensions: 4,
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      query: expect.stringContaining('Workspace Index embedding ceiling synthetic query 0'),
    });
    expect(getStatusMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      chunkCount: 2,
      chunksPerSecond: 50,
      completedChunkCount: 2,
      dimensions: 4,
      elapsedMs: 40,
      mode: 'embedding-ceiling',
      runtime: {
        actualDevice: 'webgpu',
        backendMismatch: false,
        dtype: 'fp32',
        fallbackApplied: false,
        selectedDevicePreference: 'webgpu',
      },
    });
  });

  it('throws instead of silently degrading when the embedding benchmark lacks the host bridge', async () => {
    await expect(
      runWorkspaceIndexStageBenchmark({
        request: {
          mode: 'embedding-ceiling',
        },
      })
    ).rejects.toThrow(
      "Workspace Index benchmark mode 'embedding-ceiling' requires the hidden embedding host bridge."
    );
  });

  it('throws when the embedding host reports a fallback runtime', async () => {
    const queryEmbeddingMock = vi.fn(async () => [0.1, 0.2, 0.3, 0.4]);

    await expect(
      runWorkspaceIndexStageBenchmark({
        embeddingHost: {
          getStatus: vi.fn(async () => ({
            embeddingRuntime: {
              actualWorkerMetadata: {
                device: 'wasm',
                dtype: 'fp32',
                fallbackApplied: true,
              },
              backendMismatch: true,
              selectedDevicePreference: 'webgpu',
            },
          })),
          queryEmbedding: queryEmbeddingMock,
        },
        request: {
          chunkCount: 1,
          dimensions: 4,
          mode: 'embedding-ceiling',
        },
      })
    ).rejects.toThrow('Workspace Index embedding benchmark requires WebGPU without fallback.');
    expect(queryEmbeddingMock).not.toHaveBeenCalled();
  });

  it('throws when embedding runtime evidence is incomplete', async () => {
    const queryEmbeddingMock = vi.fn(async () => [0.1, 0.2, 0.3, 0.4]);

    await expect(
      runWorkspaceIndexStageBenchmark({
        embeddingHost: {
          getStatus: vi.fn(async () => ({
            embeddingRuntime: {
              actualWorkerMetadata: {
                device: 'webgpu',
                fallbackApplied: false,
              },
              backendMismatch: false,
              selectedDevicePreference: 'webgpu',
            },
          })),
          queryEmbedding: queryEmbeddingMock,
        },
        request: {
          chunkCount: 1,
          dimensions: 4,
          mode: 'embedding-ceiling',
        },
      })
    ).rejects.toThrow('Workspace Index embedding benchmark requires complete WebGPU metadata.');
    expect(queryEmbeddingMock).not.toHaveBeenCalled();
  });
});
