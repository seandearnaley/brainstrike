import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChunk, FileChunkInsert } from '../src/models/file-chunk.js';
import { ElectronFileChunkRepository } from '../src/repositories/electron-file-chunk-repository.js';
import type { ElectronDbAPI } from '../src/repositories/electron-file-record-repository.js';

type QueryMock = ReturnType<typeof vi.fn<ElectronDbAPI['query']>>;

const createRowFromChunk = (chunk: FileChunk): Record<string, unknown> => ({
  chunk_index: chunk.chunkIndex,
  chunk_size: chunk.chunkSize,
  chunk_type: chunk.chunkType,
  content: chunk.content,
  content_hash: chunk.contentHash,
  created_at: chunk.createdAt,
  embedding: chunk.embedding ? `[${chunk.embedding.join(',')}]` : null,
  embedding_hash: chunk.embeddingHash ?? null,
  embedding_set_id: chunk.embeddingSetId ?? null,
  embedding_updated_at: chunk.embeddingUpdatedAt ?? null,
  file_record_id: chunk.fileRecordId,
  id: chunk.id,
  token_count: chunk.tokenCount,
  updated_at: chunk.updatedAt,
});

const baseChunk: FileChunk = {
  chunkIndex: 0,
  chunkSize: 128,
  chunkType: 'text',
  content: 'Hello world',
  contentHash: 'hash-123',
  createdAt: '2025-01-01T00:00:00.000Z',
  fileRecordId: 'file-1',
  id: 'chunk-1',
  tokenCount: 12,
  updatedAt: '2025-01-01T00:00:00.000Z',
};

const createRepo = () => {
  const query = vi.fn<ElectronDbAPI['query']>();
  const exec = vi.fn<ElectronDbAPI['exec']>();
  const db: ElectronDbAPI = {
    exec,
    query,
  };
  const repo = new ElectronFileChunkRepository(db);
  return { exec, query, repo };
};

// Repo whose IPC db ALSO exposes the atomic `transaction(statements, resultIndex)`
// primitive (the real desktop preload provides it; older/mocked APIs may not).
const createRepoWithTransaction = () => {
  const query = vi.fn<ElectronDbAPI['query']>();
  const exec = vi.fn<ElectronDbAPI['exec']>();
  const transaction = vi.fn<NonNullable<ElectronDbAPI['transaction']>>();
  const db: ElectronDbAPI = { exec, query, transaction };
  const repo = new ElectronFileChunkRepository(db);
  return { exec, query, repo, transaction };
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
        embeddingHash: 'embed-hash',
        embeddingSetId: 'set-1',
        embeddingUpdatedAt: '2025-01-02T00:00:00.000Z',
      }),
    };
    query.mockResolvedValueOnce({ rows: [row] });

    const result = await repo.findById('chunk-1');

    expect(result).toEqual({
      ...baseChunk,
      embedding: [0.1, 0.2],
      // Mapped chunks now also carry the embedding's dimension count.
      embeddingDimensions: 2,
      embeddingHash: 'embed-hash',
      embeddingSetId: 'set-1',
      embeddingUpdatedAt: '2025-01-02T00:00:00.000Z',
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
    query.mockResolvedValueOnce({ rows: [{ dimensions: 2, id: 'set-2' }] });
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
        content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
        id: 'chunk-null-insert',
      })
    ).rejects.toThrow('File chunk content cannot contain null bytes.');
    expect(query).not.toHaveBeenCalled();
  });

  it('supports insertMany transaction batching', async () => {
    const chunks: FileChunkInsert[] = [
      {
        ...baseChunk,
        chunkIndex: 0,
        embedding: [0.1],
        id: 'chunk-1',
      },
      {
        ...baseChunk,
        chunkIndex: 1,
        content: 'Another',
        embedding: [0.2],
        id: 'chunk-2',
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
        { ...baseChunk, content: 'clean chunk', id: 'chunk-clean' },
        {
          ...baseChunk,
          content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
          id: 'chunk-null-batch',
        },
      ])
    ).rejects.toThrow('File chunk content cannot contain null bytes.');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects null bytes in chunk content before update IPC query', async () => {
    await expect(
      repo.update({
        content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
        id: 'chunk-null-update',
        updatedAt: '2025-01-01T00:00:00.000Z',
      })
    ).rejects.toThrow('File chunk content cannot contain null bytes.');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns aggregate stats', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          average_token_count: '5',
          chunk_type: 'text',
          chunks_with_embeddings: '1',
          total_chunks: '2',
          type_count: '2',
        },
        {
          average_token_count: '8',
          chunk_type: 'code',
          chunks_with_embeddings: '2',
          total_chunks: '2',
          type_count: '2',
        },
      ],
    });

    const stats = await repo.getStats();

    expect(stats.totalChunks).toBe(4);
    expect(stats.chunksWithEmbeddings).toBe(3);
    expect(stats.chunkTypeDistribution).toEqual({ code: 2, text: 2 });
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
    query.mockResolvedValueOnce({ rows: [{ clearedCount: 3 }] });

    const cleared = await repo.clearEmbeddingsForSet('set-1');

    expect(cleared).toBe(3);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('UPDATE file_chunks');
    expect(query.mock.calls[0]?.[0]).toContain('collection_indexing_stats');
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
        return { rows: [{ dimensions: dimension, distance: 'cosine' }] };
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
        return { rows: [{ dimensions: dimension, distance: 'cosine' }] };
      }
      throw new Error(`Unexpected non-transaction query: ${sql}`);
    });
    transaction.mockResolvedValue({ rows: [] });

    await repo.searchSimilar(
      Array.from({ length: dimension }, () => 0.1),
      {
        efSearch: 120,
        embeddingSetId: 'set-1',
        limit: 5,
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
        return { rows: [{ dimensions: dimension, distance: 'cosine' }] };
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

// Selective narrowed searches must bypass the ANN index via an exact
// full-precision scan (the partial halfvec HNSW index returns as little as
// 39.5% recall@10 on ~10%-selective filters at 100k chunks — see
// docs/binary-quantization-two-stage-benchmark-2026-07-11.md). Bounded
// selectivity counts route each narrowed search; whole-set searches never count.
describe('ElectronFileChunkRepository.searchSimilar adaptive routing', () => {
  const dimension = 4;
  const queryEmbedding = Array.from({ length: dimension }, () => 0.1);

  // Sequenced mock: embedding_sets lookup, then bounded COUNT queries in call
  // order (matched first, set total second), then the search SELECT.
  const setupQueryMock = (query: QueryMock, counts: number[]) => {
    let countCall = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM embedding_sets')) {
        return { rows: [{ dimensions: dimension, distance: 'cosine' }] };
      }
      if (sql.includes('SELECT COUNT(*)')) {
        const c = counts[countCall] ?? 0;
        countCall += 1;
        return { rows: [{ c }] };
      }
      return { rows: [] };
    });
  };

  it('routes a selective narrowed search to an exact scan (no ANN transaction)', async () => {
    const { repo, query, transaction } = createRepoWithTransaction();
    // matched=10 <= 20k cap; total cap ceil(10/0.15)=67 reached -> exact.
    setupQueryMock(query as QueryMock, [10, 67]);

    await repo.searchSimilar(queryEmbedding, {
      embeddingSetId: 'set-1',
      limit: 5,
      rootIds: ['root-a'],
    });

    expect(transaction).not.toHaveBeenCalled();
    const searchSql = query.mock.calls
      .map((c) => c[0])
      .find((sql) => sql.includes('ROW_NUMBER() OVER'));
    expect(searchSql).toBeDefined();
    // Full-precision order/score expressions cannot match the halfvec HNSW
    // index -> the planner exact-scans the filtered subset.
    expect(searchSql).toContain(`$1::vector(${dimension})`);
    expect(searchSql).not.toContain('halfvec');
    expect(query.mock.calls.map((c) => c[0])).not.toContain('BEGIN');
  });

  it('keeps a large narrowed subset on the tuned ANN path (single count)', async () => {
    const { repo, query, transaction } = createRepoWithTransaction();
    // matched cap is 20_001; a full cap count means "too many for exact".
    setupQueryMock(query as QueryMock, [20_001]);
    transaction.mockResolvedValue({ rows: [] });

    await repo.searchSimilar(queryEmbedding, {
      embeddingSetId: 'set-1',
      limit: 5,
      rootIds: ['root-a'],
    });

    const countCalls = query.mock.calls.filter((c) => (c[0] as string).includes('SELECT COUNT(*)'));
    expect(countCalls).toHaveLength(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    const [statements] = transaction.mock.calls[0] as [{ sql: string }[]];
    expect(statements.at(-1)?.sql).toContain(`halfvec(${dimension})`);
  });

  it('keeps a non-selective narrowed search on the ANN path (ratio check fails)', async () => {
    const { repo, query, transaction } = createRepoWithTransaction();
    // matched=10 -> total cap 67, but the set only has 30 rows -> ratio too high.
    setupQueryMock(query as QueryMock, [10, 30]);
    transaction.mockResolvedValue({ rows: [] });

    await repo.searchSimilar(queryEmbedding, {
      embeddingSetId: 'set-1',
      limit: 5,
      rootIds: ['root-a'],
    });

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('short-circuits a zero-match narrowed search to [] without searching', async () => {
    const { repo, query, transaction } = createRepoWithTransaction();
    setupQueryMock(query as QueryMock, [0]);

    const results = await repo.searchSimilar(queryEmbedding, {
      embeddingSetId: 'set-1',
      limit: 5,
      rootIds: ['root-a'],
    });

    expect(results).toEqual([]);
    expect(transaction).not.toHaveBeenCalled();
    const sqls = query.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((sql) => sql.includes('ROW_NUMBER() OVER'))).toBe(false);
  });

  it('never runs selectivity counts for un-narrowed whole-set searches', async () => {
    const { repo, query, transaction } = createRepoWithTransaction();
    setupQueryMock(query as QueryMock, []);
    transaction.mockResolvedValue({ rows: [] });

    await repo.searchSimilar(queryEmbedding, { embeddingSetId: 'set-1', limit: 5 });

    const sqls = query.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((sql) => sql.includes('SELECT COUNT(*)'))).toBe(false);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe('ElectronFileChunkRepository.findGrepCandidates', () => {
  it('builds the trigram prefilter with rootIds and maps candidates', async () => {
    const { repo, query } = createRepo();
    query.mockResolvedValue({
      rows: [
        {
          chunk_id: 'c1',
          content: 'hello needle',
          display_name: 'Alpha',
          end_line: 7,
          path: 'src/a.ts',
          root_id: 'r1',
          start_line: 3,
        },
      ],
    });

    const candidates = await repo.findGrepCandidates({
      caseSensitive: false,
      likePattern: 'needle',
      limit: 500,
      rootIds: ['r1'],
    });

    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("fc.content ILIKE $1 ESCAPE '\\'");
    expect(sql).toContain('fr.root_id = ANY($2::text[])');
    expect(query.mock.calls[0]?.[1]).toEqual(['%needle%', ['r1'], 500]);
    expect(candidates).toEqual([
      {
        chunkId: 'c1',
        content: 'hello needle',
        endLine: 7,
        filePath: 'src/a.ts',
        rootId: 'r1',
        rootName: 'Alpha',
        startLine: 3,
      },
    ]);
  });

  it('uses LIKE (not ILIKE) when caseSensitive is true', async () => {
    const { repo, query } = createRepo();
    query.mockResolvedValue({ rows: [] });

    await repo.findGrepCandidates({
      caseSensitive: true,
      likePattern: 'needle',
      limit: 10,
    });

    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("fc.content LIKE $1 ESCAPE '\\'");
    expect(sql).not.toContain('ILIKE');
  });

  it('omits the content filter for a null likePattern (bounded scan)', async () => {
    const { repo, query } = createRepo();
    query.mockResolvedValue({ rows: [] });

    await repo.findGrepCandidates({
      caseSensitive: false,
      likePattern: null,
      limit: 10,
    });

    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).not.toContain('ILIKE');
    expect(sql).not.toContain('LIKE');
    expect(query.mock.calls[0]?.[1]).toEqual([10]);
  });

  it('returns [] for an empty rootIds allowlist without querying', async () => {
    const { repo, query } = createRepo();

    await expect(
      repo.findGrepCandidates({
        caseSensitive: false,
        likePattern: 'x',
        limit: 10,
        rootIds: [],
      })
    ).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns [] for an empty filePaths allowlist without querying', async () => {
    const { repo, query } = createRepo();

    await expect(
      repo.findGrepCandidates({
        caseSensitive: false,
        filePaths: [],
        likePattern: 'x',
        limit: 10,
      })
    ).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('maps null start/end line and null root fields to null', async () => {
    const { repo, query } = createRepo();
    query.mockResolvedValue({
      rows: [
        {
          chunk_id: 'c2',
          content: 'legacy unrooted content',
          display_name: null,
          end_line: null,
          path: 'legacy/file.ts',
          root_id: null,
          start_line: null,
        },
      ],
    });

    const candidates = await repo.findGrepCandidates({
      caseSensitive: false,
      likePattern: 'unrooted',
      limit: 10,
    });

    expect(candidates).toEqual([
      {
        chunkId: 'c2',
        content: 'legacy unrooted content',
        endLine: null,
        filePath: 'legacy/file.ts',
        rootId: null,
        rootName: null,
        startLine: null,
      },
    ]);
  });
});
