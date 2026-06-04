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
    query.mockResolvedValueOnce({ rows: [{ clearedCount: 3 }] });

    const cleared = await repo.clearEmbeddingsForSet('set-1');

    expect(cleared).toBe(3);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('UPDATE file_chunks');
    expect(query.mock.calls[0]?.[0]).toContain('collection_indexing_stats');
    expect(query.mock.calls[0]?.[1]).toEqual(['set-1']);
  });
});
