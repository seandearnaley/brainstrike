import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChunk, FileChunkInsert } from '../src/models/file-chunk.js';
import { ElectronFileChunkRepository } from '../src/repositories/electron-file-chunk-repository.js';
import type { ElectronDbAPI } from '../src/repositories/electron-file-record-repository.js';

type QueryMock = ReturnType<typeof vi.fn<ElectronDbAPI['query']>>;

const createRowFromChunk = (chunk: FileChunk): Record<string, unknown> => ({
  id: chunk.id,
  file_record_id: chunk.fileRecordId,
  chunk_index: chunk.chunkIndex,
  content: chunk.content,
  content_hash: chunk.contentHash,
  token_count: chunk.tokenCount,
  chunk_type: chunk.chunkType,
  chunk_size: chunk.chunkSize,
  embedding: chunk.embedding ? `[${chunk.embedding.join(',')}]` : null,
  embedding_set_id: chunk.embeddingSetId ?? null,
  embedding_updated_at: chunk.embeddingUpdatedAt ?? null,
  embedding_hash: chunk.embeddingHash ?? null,
  created_at: chunk.createdAt,
  updated_at: chunk.updatedAt,
});

const baseChunk: FileChunk = {
  id: 'chunk-1',
  fileRecordId: 'file-1',
  chunkIndex: 0,
  content: 'Hello world',
  contentHash: 'hash-123',
  tokenCount: 12,
  chunkType: 'text',
  chunkSize: 128,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};

const createRepo = () => {
  const query = vi.fn<ElectronDbAPI['query']>();
  const exec = vi.fn<ElectronDbAPI['exec']>();
  const db: ElectronDbAPI = {
    query,
    exec,
  };
  const repo = new ElectronFileChunkRepository(db);
  return { repo, query, exec };
};

// Repo whose IPC db ALSO exposes the atomic `transaction(statements, resultIndex)`
// primitive (the real desktop preload provides it; older/mocked APIs may not).
const createRepoWithTransaction = () => {
  const query = vi.fn<ElectronDbAPI['query']>();
  const exec = vi.fn<ElectronDbAPI['exec']>();
  const transaction = vi.fn<NonNullable<ElectronDbAPI['transaction']>>();
  const db: ElectronDbAPI = { query, exec, transaction };
  const repo = new ElectronFileChunkRepository(db);
  return { repo, query, exec, transaction };
};

describe('ElectronFileChunkRepository smoke coverage', () => {
  let query: QueryMock;
  let repo: ElectronFileChunkRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createRepo();
    repo = created.repo;
    query = created.query as QueryMock;
  });

  it('maps rows on findById', async () => {
    const row = {
      ...createRowFromChunk({
        ...baseChunk,
        embedding: [0.1, 0.2],
        embeddingSetId: 'set-1',
        embeddingUpdatedAt: '2025-01-02T00:00:00.000Z',
        embeddingHash: 'embed-hash',
      }),
    };
    query.mockResolvedValueOnce({ rows: [row] });

    const result = await repo.findById('chunk-1');

    expect(result).toEqual({
      ...baseChunk,
      embedding: [0.1, 0.2],
      // Mapped chunks now also carry the embedding's dimension count.
      embeddingDimensions: 2,
      embeddingSetId: 'set-1',
      embeddingUpdatedAt: '2025-01-02T00:00:00.000Z',
      embeddingHash: 'embed-hash',
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), ['chunk-1']);
  });

  it('returns null when findById misses', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await repo.findById('missing');

    expect(result).toBeNull();
  });

  it('serialises embeddings during insert', async () => {
    const chunk: FileChunkInsert = {
      ...baseChunk,
      embedding: [0.5, 0.8],
      embeddingSetId: 'set-2',
      embeddingUpdatedAt: '2025-01-05T00:00:00.000Z',
    };
    const expectedRow = createRowFromChunk({
      ...chunk,
      embedding: chunk.embedding,
      embeddingHash: chunk.embeddingHash ?? null,
    } as FileChunk);

    // validateEmbeddingDimensions issues: SELECT id, dimensions FROM embedding_sets WHERE id = ANY($1)
    query.mockResolvedValueOnce({ rows: [{ id: 'set-2', dimensions: 2 }] });
    query.mockResolvedValueOnce({ rows: [expectedRow] });

    const inserted = await repo.insert(chunk);

    expect(inserted.embedding).toEqual([0.5, 0.8]);
    const lastCall = query.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    expect(lastCall?.[1]?.[12]).toBe('[0.5,0.8]');
  });

  it('rejects null bytes in chunk content before insert IPC query', async () => {
    await expect(
      repo.insert({
        ...baseChunk,
        id: 'chunk-null-insert',
        content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
      })
    ).rejects.toThrow('File chunk content cannot contain null bytes.');
    expect(query).not.toHaveBeenCalled();
  });

  it('supports insertMany transaction batching', async () => {
    const chunks: FileChunkInsert[] = [
      {
        ...baseChunk,
        id: 'chunk-1',
        chunkIndex: 0,
        embedding: [0.1],
      },
      {
        ...baseChunk,
        id: 'chunk-2',
        chunkIndex: 1,
        content: 'Another',
        embedding: [0.2],
      },
    ];

    let batchIndex = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') {
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO file_chunks')) {
        const batch = chunks.slice(batchIndex, batchIndex + 2);
        batchIndex += batch.length;
        return {
          rows: batch.map((chunk) =>
            createRowFromChunk({
              ...chunk,
              embedding: chunk.embedding,
            } as FileChunk)
          ),
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await repo.insertMany(chunks);

    expect(query.mock.calls[0][0]).toBe('BEGIN');
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('chunk-1');
    expect(result[1]?.id).toBe('chunk-2');
  });

  it('rejects null bytes in chunk content before insertMany IPC transaction starts', async () => {
    await expect(
      repo.insertMany([
        { ...baseChunk, id: 'chunk-clean', content: 'clean chunk' },
        {
          ...baseChunk,
          id: 'chunk-null-batch',
          content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
        },
      ])
    ).rejects.toThrow('File chunk content cannot contain null bytes.');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects null bytes in chunk content before update IPC query', async () => {
    await expect(
      repo.update({
        id: 'chunk-null-update',
        content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
        updatedAt: '2025-01-01T00:00:00.000Z',
      })
    ).rejects.toThrow('File chunk content cannot contain null bytes.');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns aggregate stats', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          total_chunks: '2',
          chunks_with_embeddings: '1',
          average_token_count: '5',
          chunk_type: 'text',
          type_count: '2',
        },
        {
          total_chunks: '2',
          chunks_with_embeddings: '2',
          average_token_count: '8',
          chunk_type: 'code',
          type_count: '2',
        },
      ],
    });

    const stats = await repo.getStats();

    expect(stats.totalChunks).toBe(4);
    expect(stats.chunksWithEmbeddings).toBe(3);
    expect(stats.chunkTypeDistribution).toEqual({ text: 2, code: 2 });
    expect(stats.averageTokenCount).toBeCloseTo((5 * 2 + 8 * 2) / 4);
  });

  it('clears all rows with count', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: '3' }] });
    query.mockResolvedValueOnce({ rows: [] });

    const deleted = await repo.clearAll();

    expect(deleted).toBe(3);
    expect(query.mock.calls[1][0]).toBe('DELETE FROM file_chunks');
  });

  it('clears embeddings and refreshes stats in one atomic query', async () => {
    query.mockResolvedValueOnce({
      rows: [{ clearedCount: 3, refreshedCount: 1, requestedCount: 1 }],
    });

    const cleared = await repo.clearEmbeddingsForSet('set-1');

    expect(cleared).toBe(3);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('UPDATE file_chunks');
    expect(query.mock.calls[0]?.[0]).toContain('FROM embedding_sets s');
    expect(query.mock.calls[0]?.[0]).toContain('JOIN file_records fr');
    expect(query.mock.calls[0]?.[0]).toContain('c.embedding_set_id IS NULL');
    expect(query.mock.calls[0]?.[0]).toContain('requestedCount');
    expect(query.mock.calls[0]?.[0]).toContain('refreshedCount');
    expect(query.mock.calls[0]?.[0]).toContain('collection_indexing_stats');
    expect(query.mock.calls[0]?.[1]).toEqual(['set-1']);
  });

  it('builds coverage with direct-or-inherited effective membership', async () => {
    query.mockResolvedValueOnce({
      rows: [{ chunksWithEmbeddingsForSet: '3', totalChunks: '3' }],
    });

    const coverage = await repo.getCoverageForSet('set-1');

    expect(coverage).toEqual({ chunksWithEmbeddingsForSet: 3, totalChunks: 3 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('JOIN target ON (');
    expect(query.mock.calls[0]?.[0]).toContain('c.embedding_set_id = target.embedding_set_id');
    expect(query.mock.calls[0]?.[0]).toContain('c.embedding_set_id IS NULL');
    expect(query.mock.calls[0]?.[0]).not.toContain(
      'JOIN target ON fr.embedding_set_id = target.embedding_set_id'
    );
    expect(query.mock.calls[0]?.[1]).toEqual(['set-1']);
  });

  // #1141: desktop vector search must match the partial half-precision HNSW index
  // `(embedding::halfvec(N)) … WHERE vector_dims(embedding) = N` (mirroring the
  // PGlite-direct repo). A bare `embedding <=> $1::vector` (column uncast, no dims
  // predicate) can't use that index → seq scan, which also makes the ef_search /
  // iterative_scan tuning inert. Pin the index-matching SQL shape.
  it('builds an index-matching halfvec search (column cast + vector_dims predicate)', async () => {
    const dimension = 768;
    const queryEmbedding = Array.from({ length: dimension }, () => 0.1);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM embedding_sets')) {
        return { rows: [{ distance: 'cosine', dimensions: dimension }] };
      }
      // BEGIN / COMMIT / SET LOCAL tuning / the SELECT all return no rows here.
      return { rows: [] };
    });

    await repo.searchSimilar(queryEmbedding, { embeddingSetId: 'set-1', limit: 5 });

    const searchSql = query.mock.calls
      .map((call) => call[0])
      .find((sql) => sql.includes('ROW_NUMBER() OVER'));
    expect(searchSql).toBeDefined();
    // Column cast to fixed-dim halfvec so the ORDER BY can use the partial index.
    expect(searchSql).toContain(`embedding::halfvec(${dimension})`);
    expect(searchSql).toContain(`$1::halfvec(${dimension})`);
    // The partial-index predicate the planner needs to pick the dimension index.
    expect(searchSql).toContain(`vector_dims(embedding) = ${dimension}`);
    // The old uncast form must be gone.
    expect(searchSql).not.toContain('embedding <=> $1::vector');
  });

  // #1141 part (b): when the IPC db exposes the atomic `transaction` primitive, the
  // vector search must run its tuning + SELECT through ONE transaction() call (so
  // pglite.transaction() in main holds the connection lock and a concurrent FTS
  // SELECT from HybridSearchService's Promise.all can't interleave) — NOT via the
  // raw BEGIN/COMMIT path that doesn't serialize over IPC.
  it('runs the vector search via the atomic transaction primitive when available', async () => {
    const { repo, query, transaction } = createRepoWithTransaction();
    const dimension = 4;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM embedding_sets')) {
        return { rows: [{ distance: 'cosine', dimensions: dimension }] };
      }
      throw new Error(`Unexpected non-transaction query: ${sql}`);
    });
    transaction.mockResolvedValue({ rows: [] });

    await repo.searchSimilar(
      Array.from({ length: dimension }, () => 0.1),
      {
        embeddingSetId: 'set-1',
        limit: 5,
        efSearch: 120,
      }
    );

    // No raw BEGIN/COMMIT/ROLLBACK on the IPC connection.
    const rawTxCalls = query.mock.calls
      .map((c) => c[0])
      .filter((sql) => sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK');
    expect(rawTxCalls).toEqual([]);

    // One atomic transaction call carrying tuning statements + the SELECT, with the
    // result index pointing at the final SELECT.
    expect(transaction).toHaveBeenCalledTimes(1);
    const [statements, resultIndex] = transaction.mock.calls[0] as [
      { sql: string; params?: unknown[] }[],
      number,
    ];
    const sqls = statements.map((s) => s.sql);
    expect(sqls.some((s) => s.includes('SET LOCAL hnsw.ef_search'))).toBe(true);
    expect(sqls.some((s) => s.includes("hnsw.iterative_scan = 'strict_order'"))).toBe(true);
    expect(sqls.at(-1)).toContain('ROW_NUMBER() OVER');
    expect(resultIndex).toBe(statements.length - 1);
    // The SELECT statement carries the bound params (query vector + limit).
    expect(statements.at(-1)?.params?.length).toBeGreaterThan(0);
  });

  it('falls back to raw BEGIN/COMMIT when the IPC db has no transaction primitive', async () => {
    const { repo, query } = createRepo();
    const dimension = 4;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM embedding_sets')) {
        return { rows: [{ distance: 'cosine', dimensions: dimension }] };
      }
      return { rows: [] };
    });

    await repo.searchSimilar(
      Array.from({ length: dimension }, () => 0.1),
      {
        embeddingSetId: 'set-1',
        limit: 5,
      }
    );

    const calls = query.mock.calls.map((c) => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
  });
});
