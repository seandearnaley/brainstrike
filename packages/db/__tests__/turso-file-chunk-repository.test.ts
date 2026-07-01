import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainstrikeDbExecutionClient } from '../src/architecture/brainstrike-db-client-contract.js';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import type { FileRecord } from '../src/models/file-record.js';
import {
  buildEmbeddingJobDedupeKey,
  buildEmbeddingJobDedupeKeySqlExpression,
} from '../src/queue/embedding-job-dedupe-key.js';
import { TursoEmbeddingSetsRepository } from '../src/repositories/turso-embedding-sets-repository.js';
import { TursoFileChunkRepository } from '../src/repositories/turso-file-chunk-repository.js';
import { TursoFileRecordRepository } from '../src/repositories/turso-file-record-repository.js';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import { applyTursoSchemaBaseline } from '../src/turso/schema-baseline.js';

describe('TursoFileChunkRepository', () => {
  let client: TursoOwnerClient;
  let embeddingSetsRepository: TursoEmbeddingSetsRepository;
  let fileRecordsRepository: TursoFileRecordRepository;
  let repository: TursoFileChunkRepository;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-file-chunks-'));
    client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
    await applyTursoSchemaBaseline(client);
    embeddingSetsRepository = new TursoEmbeddingSetsRepository(client);
    fileRecordsRepository = new TursoFileRecordRepository(client);
    repository = new TursoFileChunkRepository(client);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('inserts, upserts, and reads chunks through the Turso schema shape', async () => {
    await fileRecordsRepository.createWithContent(createRecord({ id: 'file-1' }));
    await fileRecordsRepository.createWithContent(
      createRecord({ id: 'file-2', path: 'src/two.ts' })
    );

    await expect(repository.insert(createChunk({ id: 'chunk-1' }))).resolves.toMatchObject({
      chunkIndex: 0,
      content: 'const answer = 42;',
      contentHash: 'hash-chunk-1',
      fileRecordId: 'file-1',
      id: 'chunk-1',
    });

    await repository.insert(
      createChunk({
        chunkIndex: 9,
        chunkSize: 24,
        content: 'const answer = 43;',
        contentHash: 'hash-chunk-1-updated',
        fileRecordId: 'file-2',
        id: 'chunk-1',
        tokenCount: 5,
        updatedAt: '2026-06-23T08:30:00.000Z',
      })
    );
    await repository.insert(createChunk({ chunkIndex: 1, id: 'chunk-2' }));

    await expect(repository.findById('chunk-1')).resolves.toMatchObject({
      chunkIndex: 0,
      chunkSize: 24,
      content: 'const answer = 43;',
      contentHash: 'hash-chunk-1-updated',
      fileRecordId: 'file-1',
      tokenCount: 5,
      updatedAt: '2026-06-23T08:30:00.000Z',
    });
    await expect(repository.findByFileRecordId('file-1')).resolves.toEqual([
      expect.objectContaining({ id: 'chunk-1' }),
      expect.objectContaining({ id: 'chunk-2' }),
    ]);
  });

  it('does not prepare vector functions when inserting chunks without embeddings', async () => {
    const insertedRow = {
      chunk_index: 0,
      chunk_size: 18,
      chunk_type: 'code',
      content: 'const answer = 42;',
      content_hash: 'hash-chunk-1',
      created_at: '2026-06-23T08:10:00.000Z',
      embedding: null,
      embedding_hash: null,
      embedding_set_id: null,
      embedding_updated_at: null,
      end_line: null,
      end_offset: null,
      file_record_id: 'file-1',
      id: 'chunk-no-embedding',
      start_line: null,
      start_offset: null,
      token_count: 4,
      updated_at: '2026-06-23T08:10:00.000Z',
    };
    let capturedInsertSql = '';
    const transactionClient = {
      exec: vi.fn(async () => {}),
      query: vi.fn(async (sql: string) => {
        capturedInsertSql = sql;
        return { rows: [insertedRow] };
      }),
    };
    const repositoryWithoutVector = new TursoFileChunkRepository({
      exec: vi.fn(async () => {}),
      query: vi.fn(async () => ({ rows: [] })),
      transaction: vi.fn(async (callback) => callback(transactionClient)),
    });

    await repositoryWithoutVector.insert(
      createChunk({ embedding: undefined, id: 'chunk-no-embedding' })
    );

    expect(capturedInsertSql).toContain('INSERT INTO file_chunks');
    expect(capturedInsertSql).toContain('NULL');
    expect(capturedInsertSql).not.toContain('vector32(');
  });

  it('reads legacy JSON embedding blobs from pre-vector Turso profiles', async () => {
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:legacy-json',
      'legacy json',
      3,
      'cosine'
    );
    await fileRecordsRepository.createWithContent(
      createRecord({
        embeddingSetId: embeddingSet.id,
        id: 'file-legacy-json',
        path: 'src/legacy-json.ts',
      })
    );
    await client.exec(
      `INSERT INTO file_chunks (
         id,
         file_record_id,
         chunk_index,
         content,
         content_hash,
         token_count,
         chunk_type,
         chunk_size,
         embedding,
         embedding_set_id,
         embedding_updated_at,
         embedding_hash,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'chunk-legacy-json',
        'file-legacy-json',
        0,
        'legacy embedding',
        'hash-legacy-json',
        3,
        'code',
        16,
        new TextEncoder().encode(JSON.stringify([0.1, 0.2, 0.3])),
        embeddingSet.id,
        '2026-06-23T08:10:00.000Z',
        'hash-embedding-legacy-json',
        '2026-06-23T08:10:00.000Z',
        '2026-06-23T08:10:00.000Z',
      ]
    );

    await expect(repository.findById('chunk-legacy-json')).resolves.toMatchObject({
      embedding: [0.1, 0.2, 0.3],
      embeddingDimensions: 3,
      embeddingHash: 'hash-embedding-legacy-json',
      embeddingSetId: embeddingSet.id,
      id: 'chunk-legacy-json',
    });
  });

  it('reads native vector32 blobs when the first float byte looks like JSON', async () => {
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:native-leading-bracket',
      'native leading bracket',
      3,
      'cosine'
    );
    await fileRecordsRepository.createWithContent(
      createRecord({
        embeddingSetId: embeddingSet.id,
        id: 'file-native-leading-bracket',
        path: 'src/native-leading-bracket.ts',
      })
    );

    await expect(
      repository.insert(
        createChunk({
          embedding: [1.000_010_848_045_349_1, 0, 0],
          embeddingSetId: embeddingSet.id,
          fileRecordId: 'file-native-leading-bracket',
          id: 'chunk-native-leading-bracket',
        })
      )
    ).resolves.toMatchObject({
      embedding: [1.000_011, 0, 0],
      embeddingDimensions: 3,
      id: 'chunk-native-leading-bracket',
    });
  });

  it('batch inserts atomically and rejects null-byte content before writing', async () => {
    await fileRecordsRepository.createWithContent(createRecord({ id: 'file-1' }));

    await expect(
      repository.insertMany([
        createChunk({ chunkIndex: 0, id: 'chunk-1' }),
        createChunk({
          chunkIndex: 1,
          content: `valid-prefix${String.fromCharCode(0)}invalid`,
          id: 'chunk-2',
        }),
      ])
    ).rejects.toThrow('File chunk content cannot contain null bytes.');

    await expect(repository.findByFileRecordId('file-1')).resolves.toEqual([]);

    await expect(
      repository.insertMany([
        createChunk({ chunkIndex: 1, id: 'chunk-2' }),
        createChunk({ chunkIndex: 0, id: 'chunk-1' }),
      ])
    ).resolves.toHaveLength(2);
    await expect(repository.findByFileRecordId('file-1')).resolves.toEqual([
      expect.objectContaining({ id: 'chunk-1' }),
      expect.objectContaining({ id: 'chunk-2' }),
    ]);
  });

  it('supports transaction-scoped batch inserts for chunk and job enqueue orchestration', async () => {
    await fileRecordsRepository.createWithContent(createRecord({ id: 'file-1' }));

    const inserted = await client.transaction(async (tx) => {
      const chunks = await repository.insertManyWithTx(tx, [
        createChunk({ chunkIndex: 0, id: 'chunk-1' }),
        createChunk({ chunkIndex: 1, id: 'chunk-2' }),
      ]);
      await tx.exec(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          'job-1',
          'embedding',
          'embed_chunk',
          JSON.stringify({ chunkId: 'chunk-1' }),
          'queued',
          '2026-06-23T08:20:00.000Z',
          '2026-06-23T08:20:00.000Z',
        ]
      );
      return chunks;
    });

    expect(inserted).toEqual([
      expect.objectContaining({ id: 'chunk-1' }),
      expect.objectContaining({ id: 'chunk-2' }),
    ]);
    await expect(repository.findByFileRecordId('file-1')).resolves.toHaveLength(2);
    await expect(
      client.query<{ count: number }>('SELECT COUNT(*) AS count FROM job_queue WHERE id = ?', [
        'job-1',
      ])
    ).resolves.toEqual({ rows: [{ count: 1 }] });
  });

  it('updates content, positions, and embedding metadata with a Turso blob round trip', async () => {
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:small',
      'small',
      3,
      'cosine'
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: embeddingSet.id, id: 'file-1' })
    );
    await repository.insert(createChunk({ id: 'chunk-1' }));

    await expect(
      repository.update({
        chunkSize: 19,
        content: 'const updated = true;',
        contentHash: 'hash-updated',
        embedding: [0.1, 0.2, 0.3],
        embeddingHash: 'embedding-hash',
        embeddingSetId: embeddingSet.id,
        embeddingUpdatedAt: '2026-06-23T08:45:00.000Z',
        endLine: 7,
        id: 'chunk-1',
        startLine: 4,
        tokenCount: 6,
        updatedAt: '2026-06-23T08:45:00.000Z',
      })
    ).resolves.toMatchObject({
      chunkSize: 19,
      content: 'const updated = true;',
      embedding: [0.1, 0.2, 0.3],
      embeddingDimensions: 3,
      embeddingHash: 'embedding-hash',
      embeddingSetId: embeddingSet.id,
      embeddingUpdatedAt: '2026-06-23T08:45:00.000Z',
      endLine: 7,
      startLine: 4,
    });

    await expect(
      repository.update({
        embedding: [0.1, 0.2],
        embeddingSetId: embeddingSet.id,
        id: 'chunk-1',
        updatedAt: '2026-06-23T08:46:00.000Z',
      })
    ).rejects.toThrow('Embedding dimension mismatch: received 2, expected 3.');
    await expect(repository.findById('chunk-1')).resolves.toMatchObject({
      embedding: [0.1, 0.2, 0.3],
      updatedAt: '2026-06-23T08:45:00.000Z',
    });
  });

  it('updates embedding set metadata without requiring a new vector payload', async () => {
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:small',
      'small',
      3,
      'cosine'
    );
    const wrongDimensionSet = await embeddingSetsRepository.getOrCreateSet(
      'test:larger',
      'larger',
      4,
      'cosine'
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: embeddingSet.id, id: 'file-1' })
    );
    await repository.insert(createChunk({ id: 'chunk-1' }));
    await repository.update({
      embedding: [0.1, 0.2, 0.3],
      id: 'chunk-1',
      updatedAt: '2026-06-23T08:45:00.000Z',
    });

    await expect(
      repository.update({
        embeddingHash: 'metadata-hash',
        embeddingSetId: embeddingSet.id,
        embeddingUpdatedAt: '2026-06-23T08:46:00.000Z',
        id: 'chunk-1',
        updatedAt: '2026-06-23T08:46:00.000Z',
      })
    ).resolves.toMatchObject({
      embedding: [0.1, 0.2, 0.3],
      embeddingHash: 'metadata-hash',
      embeddingSetId: embeddingSet.id,
      embeddingUpdatedAt: '2026-06-23T08:46:00.000Z',
    });

    await expect(
      repository.update({
        embeddingSetId: wrongDimensionSet.id,
        id: 'chunk-1',
        updatedAt: '2026-06-23T08:47:00.000Z',
      })
    ).rejects.toThrow('Embedding dimension mismatch: received 3, expected 4.');
    await expect(
      repository.update({
        embeddingSetId: 'missing-set',
        id: 'chunk-1',
        updatedAt: '2026-06-23T08:48:00.000Z',
      })
    ).rejects.toThrow('Embedding set missing-set is missing or has invalid dimensions.');
    await expect(repository.findById('chunk-1')).resolves.toMatchObject({
      embeddingSetId: embeddingSet.id,
    });
  });

  it('does not fetch the existing chunk for non-embedding updates', async () => {
    const queryCalls: string[] = [];
    const exec = vi.fn(async () => {});
    const query = vi.fn(async (sql: string) => {
      queryCalls.push(sql);
      if (sql.includes('SELECT') && sql.includes('FROM file_chunks')) {
        throw new Error('non-embedding update should not read the existing chunk');
      }
      return {
        rows: [
          {
            chunk_index: 0,
            chunk_size: 19,
            chunk_type: 'code',
            content: 'const updated = true;',
            content_hash: 'hash-updated',
            created_at: '2026-06-23T08:10:00.000Z',
            embedding: null,
            embedding_hash: null,
            embedding_set_id: null,
            embedding_updated_at: null,
            end_line: null,
            end_offset: null,
            file_record_id: 'file-1',
            id: 'chunk-1',
            start_line: null,
            start_offset: null,
            token_count: 6,
            updated_at: '2026-06-23T08:45:00.000Z',
          },
        ],
      };
    });
    const fakeDb: BrainstrikeDbExecutionClient = {
      exec,
      query,
      transaction: vi.fn(async (callback) => callback({ exec, query })),
    };
    const fakeRepository = new TursoFileChunkRepository(fakeDb);

    await expect(
      fakeRepository.update({
        content: 'const updated = true;',
        contentHash: 'hash-updated',
        id: 'chunk-1',
        tokenCount: 6,
        updatedAt: '2026-06-23T08:45:00.000Z',
      })
    ).resolves.toMatchObject({ content: 'const updated = true;', id: 'chunk-1' });
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]).toContain('UPDATE file_chunks');
  });

  it('reports stats, coverage, and clears embeddings for a set', async () => {
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:small',
      'small',
      3,
      'cosine'
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: embeddingSet.id, id: 'file-1' })
    );
    await repository.insertMany([
      createChunk({
        chunkIndex: 0,
        embedding: [0.1, 0.2, 0.3],
        embeddingSetId: embeddingSet.id,
        id: 'chunk-1',
        tokenCount: 5,
      }),
      createChunk({
        chunkIndex: 1,
        embedding: [0.3, 0.2, 0.1],
        id: 'chunk-2',
        tokenCount: 7,
      }),
    ]);

    await expect(repository.getStats()).resolves.toEqual({
      averageTokenCount: 6,
      chunkTypeDistribution: { code: 2 },
      chunksWithEmbeddings: 2,
      totalChunks: 2,
    });
    await expect(repository.getCoverageForSet(embeddingSet.id)).resolves.toEqual({
      chunksWithEmbeddingsForSet: 2,
      totalChunks: 2,
    });

    await expect(repository.clearEmbeddingsForSet(embeddingSet.id)).resolves.toBe(2);
    const clearedChunk = await repository.findById('chunk-1');
    expect(clearedChunk).toMatchObject({ embeddingSetId: embeddingSet.id });
    expect(clearedChunk).not.toHaveProperty('embedding');
    expect(clearedChunk).not.toHaveProperty('embeddingHash');
    expect(clearedChunk).not.toHaveProperty('embeddingUpdatedAt');
    const inheritedClearedChunk = await repository.findById('chunk-2');
    expect(inheritedClearedChunk).toMatchObject({ id: 'chunk-2' });
    expect(inheritedClearedChunk).not.toHaveProperty('embeddingSetId');
    expect(inheritedClearedChunk).not.toHaveProperty('embedding');
    expect(inheritedClearedChunk).not.toHaveProperty('embeddingHash');
    expect(inheritedClearedChunk).not.toHaveProperty('embeddingUpdatedAt');
    await expect(
      client.query<{
        chunk_count: number;
        dirty: number;
        embedded_chunk_count: number;
        file_count: number;
        pending_chunk_count: number;
      }>(
        `SELECT file_count, chunk_count, embedded_chunk_count, pending_chunk_count, dirty
           FROM collection_indexing_stats
          WHERE embedding_set_id = ?`,
        [embeddingSet.id]
      )
    ).resolves.toEqual({
      rows: [
        {
          chunk_count: 2,
          dirty: 0,
          embedded_chunk_count: 0,
          file_count: 1,
          pending_chunk_count: 2,
        },
      ],
    });
  });

  it('reports collection embedding coverage without selecting embedding payloads', async () => {
    const queryCalls: string[] = [];
    const originalQuery = client.query.bind(client);
    vi.spyOn(client, 'query').mockImplementation(
      async (sql: string, params?: readonly unknown[]) => {
        queryCalls.push(sql);
        return originalQuery(sql, params);
      }
    );
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:small',
      'small',
      3,
      'cosine'
    );
    const otherEmbeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:other',
      'other',
      3,
      'cosine'
    );
    await fileRecordsRepository.create(
      createRecord({
        embeddingSetId: embeddingSet.id,
        id: 'file-1',
      })
    );
    await fileRecordsRepository.create(
      createRecord({
        embeddingSetId: embeddingSet.id,
        id: 'file-2',
        path: 'src/two.ts',
      })
    );
    await fileRecordsRepository.create(
      createRecord({
        embeddingSetId: otherEmbeddingSet.id,
        id: 'file-other',
        path: 'src/other.ts',
      })
    );
    await fileRecordsRepository.update('file-1', {
      chunksProcessedAt: '2026-06-23T08:15:00.000Z',
    });
    await fileRecordsRepository.update('file-other', {
      chunksProcessedAt: '2026-06-23T08:15:00.000Z',
    });
    await repository.insertMany([
      createChunk({
        chunkIndex: 0,
        embedding: [0.1, 0.2, 0.3],
        embeddingSetId: embeddingSet.id,
        endLine: 3,
        endOffset: 30,
        fileRecordId: 'file-1',
        id: 'chunk-1',
        startLine: 1,
        startOffset: 0,
      }),
      createChunk({
        chunkIndex: 1,
        embedding: [0.4, 0.5, 0.6],
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-1',
        id: 'chunk-missing-ranges',
      }),
      createChunk({
        chunkIndex: 0,
        fileRecordId: 'file-2',
        id: 'chunk-pending',
      }),
      createChunk({
        chunkIndex: 0,
        embedding: [0.7, 0.8, 0.9],
        embeddingSetId: otherEmbeddingSet.id,
        fileRecordId: 'file-other',
        id: 'chunk-other',
      }),
    ]);

    await expect(repository.getCollectionEmbeddingCoverage(embeddingSet.id)).resolves.toEqual({
      chunksMissingSourceRange: 2,
      pendingReindexFileCount: 1,
      totalChunks: 3,
      totalFiles: 2,
    });
    const coverageQuery = queryCalls.at(-1) ?? '';
    expect(coverageQuery).toContain('FROM file_records fr');
    expect(coverageQuery).not.toMatch(/\bembedding\b\s*(?:,|FROM)/i);
    expect(coverageQuery).not.toContain('::');
    expect(coverageQuery).not.toContain('FILTER');
    expect(coverageQuery).not.toContain('ANY(');
  });

  it('counts embedded chunks by file record without selecting embedding payloads', async () => {
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:small',
      'small',
      3,
      'cosine'
    );
    const otherEmbeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:other',
      'other',
      3,
      'cosine'
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: embeddingSet.id, id: 'file-1' })
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: embeddingSet.id, id: 'file-2', path: 'src/two.ts' })
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: otherEmbeddingSet.id, id: 'file-other', path: 'src/other.ts' })
    );
    await repository.insertMany([
      createChunk({
        chunkIndex: 0,
        embedding: [0.1, 0.2, 0.3],
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-1',
        id: 'chunk-1',
      }),
      createChunk({ chunkIndex: 1, fileRecordId: 'file-1', id: 'chunk-2' }),
      createChunk({
        chunkIndex: 0,
        embedding: [0.4, 0.5, 0.6],
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-2',
        id: 'chunk-3',
      }),
      createChunk({
        chunkIndex: 0,
        embedding: [0.7, 0.8, 0.9],
        embeddingSetId: otherEmbeddingSet.id,
        fileRecordId: 'file-other',
        id: 'chunk-other',
      }),
    ]);

    await expect(
      repository.countEmbeddedByFileRecordIds(['file-1', 'file-2'], embeddingSet.id)
    ).resolves.toEqual(
      new Map([
        ['file-1', 1],
        ['file-2', 1],
      ])
    );
  });

  it('selects Turso embedding backfill candidates without Postgres SQL features', async () => {
    const queryCalls: string[] = [];
    const originalQuery = client.query.bind(client);
    vi.spyOn(client, 'query').mockImplementation(
      async (sql: string, params?: readonly unknown[]) => {
        queryCalls.push(sql);
        return originalQuery(sql, params);
      }
    );
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:small',
      'small',
      3,
      'cosine'
    );
    const otherEmbeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:other',
      'other',
      3,
      'cosine'
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: embeddingSet.id, id: 'file-1' })
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: embeddingSet.id, id: 'file-2', path: 'src/two.ts' })
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: otherEmbeddingSet.id, id: 'file-other', path: 'src/other.ts' })
    );
    await repository.insertMany([
      createChunk({
        contentHash: 'hash-01',
        fileRecordId: 'file-1',
        id: 'chunk-01',
      }),
      createChunk({
        chunkIndex: 1,
        contentHash: 'hash-02-active',
        fileRecordId: 'file-1',
        id: 'chunk-02-active',
      }),
      createChunk({
        chunkIndex: 2,
        contentHash: 'hash-03-inherited',
        fileRecordId: 'file-1',
        id: 'chunk-03-inherited',
      }),
      createChunk({
        chunkIndex: 3,
        contentHash: 'hash-03-inherited-active',
        fileRecordId: 'file-1',
        id: 'chunk-03-inherited-active',
      }),
      createChunk({
        chunkIndex: 0,
        contentHash: 'hash-04-embedded',
        embedding: [0.1, 0.2, 0.3],
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-2',
        id: 'chunk-04-embedded',
      }),
      createChunk({
        chunkIndex: 1,
        contentHash: 'hash-05-running',
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-2',
        id: 'chunk-05-running',
      }),
      createChunk({
        chunkIndex: 2,
        contentHash: 'hash-06-failed',
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-2',
        id: 'chunk-06-failed',
      }),
      createChunk({
        chunkIndex: 3,
        contentHash: 'hash-07-succeeded',
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-2',
        id: 'chunk-07-succeeded',
      }),
      createChunk({
        contentHash: 'hash-other',
        embeddingSetId: otherEmbeddingSet.id,
        fileRecordId: 'file-other',
        id: 'chunk-other',
      }),
    ]);
    await insertRawEmbeddingJob(client, {
      chunkId: 'chunk-02-active',
      dedupeKey: buildEmbeddingJobDedupeKey('chunk-02-active', embeddingSet.id, 'hash-02-active'),
      embeddingSetId: embeddingSet.id,
      id: 'job-queued',
      state: 'queued',
    });
    await insertRawEmbeddingJob(client, {
      chunkId: 'chunk-03-inherited-active',
      dedupeKey: buildEmbeddingJobDedupeKey(
        'chunk-03-inherited-active',
        null,
        'hash-03-inherited-active'
      ),
      embeddingSetId: null,
      id: 'job-inherited-null-set',
      state: 'queued',
    });
    await insertRawEmbeddingJob(client, {
      chunkId: 'chunk-05-running',
      dedupeKey: buildEmbeddingJobDedupeKey('chunk-05-running', embeddingSet.id, 'hash-05-running'),
      embeddingSetId: embeddingSet.id,
      id: 'job-running',
      state: 'running',
    });
    await insertRawEmbeddingJob(client, {
      chunkId: 'chunk-06-failed',
      dedupeKey: buildEmbeddingJobDedupeKey('chunk-06-failed', embeddingSet.id, 'hash-06-failed'),
      embeddingSetId: embeddingSet.id,
      id: 'job-failed',
      state: 'failed',
    });
    await insertRawEmbeddingJob(client, {
      chunkId: 'chunk-07-succeeded',
      dedupeKey: buildEmbeddingJobDedupeKey(
        'chunk-07-succeeded',
        embeddingSet.id,
        'hash-07-succeeded'
      ),
      embeddingSetId: embeddingSet.id,
      id: 'job-succeeded',
      state: 'succeeded',
    });

    await expect(repository.countEmbeddingBackfillCandidates(embeddingSet.id)).resolves.toBe(4);
    await expect(
      repository.getEmbeddingBackfillCandidateDiagnostics(embeddingSet.id)
    ).resolves.toEqual({
      candidateCount: 4,
      chunkCount: 8,
      embeddedChunkCount: 1,
      failedJobs: 1,
      fileCount: 2,
      missingContentHashCount: 0,
      pendingChunkCount: 7,
      queuedOrRunningJobs: 2,
    });
    await expect(
      repository.findEmbeddingBackfillCandidates({
        afterChunkId: null,
        embeddingSetId: embeddingSet.id,
        limit: 2,
      })
    ).resolves.toEqual([
      { contentHash: 'hash-01', fileRecordId: 'file-1', id: 'chunk-01' },
      { contentHash: 'hash-03-inherited', fileRecordId: 'file-1', id: 'chunk-03-inherited' },
    ]);
    await expect(
      repository.findEmbeddingBackfillCandidates({
        afterChunkId: 'chunk-03-inherited',
        embeddingSetId: embeddingSet.id,
        limit: 10,
      })
    ).resolves.toEqual([
      { contentHash: 'hash-06-failed', fileRecordId: 'file-2', id: 'chunk-06-failed' },
      { contentHash: 'hash-07-succeeded', fileRecordId: 'file-2', id: 'chunk-07-succeeded' },
    ]);

    const backfillQueries = queryCalls.filter(
      (sql) => sql.includes('FROM file_chunks c') || sql.includes('FROM job_queue j')
    );
    const canonicalDedupeExpression = buildEmbeddingJobDedupeKeySqlExpression({
      chunkIdExpression: 'c.id',
      contentHashExpression: 'c.content_hash',
      embeddingSetIdExpression: '?',
    });
    expect(backfillQueries.join('\n')).toContain(`j.dedupe_key = ${canonicalDedupeExpression}`);
    const diagnosticsQuery = backfillQueries.find(
      (sql) => sql.includes('AS candidateCount') && sql.includes('AS queuedOrRunningJobs')
    );
    expect(diagnosticsQuery).toBeDefined();
    expect(diagnosticsQuery?.match(/FROM file_chunks c/g)).toHaveLength(1);
    expect(diagnosticsQuery).toContain('SUM(CASE WHEN');
    expect(backfillQueries.join('\n')).not.toContain('::');
    expect(backfillQueries.join('\n')).not.toContain('FILTER');
    expect(backfillQueries.join('\n')).not.toContain('ANY(');
    expect(backfillQueries.join('\n')).not.toContain('$1');
  });

  it('fails closed when Turso embedding backfill sees pending chunks without content hashes', async () => {
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:small',
      'small',
      3,
      'cosine'
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: embeddingSet.id, id: 'file-1' })
    );
    await client.exec(
      `INSERT INTO file_chunks (
         id,
         file_record_id,
         chunk_index,
         content,
         content_hash,
         token_count,
         chunk_type,
         chunk_size,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      [
        'chunk-missing-hash',
        'file-1',
        0,
        'const answer = 42;',
        4,
        'code',
        18,
        '2026-06-23T08:10:00.000Z',
        '2026-06-23T08:10:00.000Z',
      ]
    );

    await expect(
      repository.getEmbeddingBackfillCandidateDiagnostics(embeddingSet.id)
    ).resolves.toEqual({
      candidateCount: 0,
      chunkCount: 1,
      embeddedChunkCount: 0,
      failedJobs: 0,
      fileCount: 1,
      missingContentHashCount: 1,
      pendingChunkCount: 1,
      queuedOrRunningJobs: 0,
    });
    await expect(repository.countEmbeddingBackfillCandidates(embeddingSet.id)).rejects.toThrow(
      `Embedding backfill cannot enqueue 1 chunk(s) for embedding set '${embeddingSet.id}' because content_hash is missing.`
    );
    await expect(
      repository.findEmbeddingBackfillCandidates({
        embeddingSetId: embeddingSet.id,
        limit: 10,
      })
    ).rejects.toThrow(
      `Embedding backfill cannot enqueue 1 chunk(s) for embedding set '${embeddingSet.id}' because content_hash is missing.`
    );
  });

  it('deletes chunks, clears all chunks, and relies on Turso foreign-key cascades', async () => {
    await fileRecordsRepository.createWithContent(createRecord({ id: 'file-1' }));
    await fileRecordsRepository.createWithContent(
      createRecord({ id: 'file-2', path: 'src/two.ts' })
    );
    await repository.insertMany([
      createChunk({ chunkIndex: 0, fileRecordId: 'file-1', id: 'chunk-1' }),
      createChunk({ chunkIndex: 1, fileRecordId: 'file-1', id: 'chunk-2' }),
      createChunk({ fileRecordId: 'file-2', id: 'chunk-3' }),
    ]);

    await expect(repository.delete('chunk-1')).resolves.toBe(true);
    await expect(repository.delete('missing')).resolves.toBe(false);
    await expect(repository.deleteByFileRecordId('file-1')).resolves.toBe(1);

    await repository.insertMany([
      createChunk({ fileRecordId: 'file-1', id: 'chunk-4' }),
      createChunk({ fileRecordId: 'file-2', id: 'chunk-5' }),
    ]);
    await client.exec('DELETE FROM file_records WHERE id = ?', ['file-2']);
    await expect(repository.findById('chunk-3')).resolves.toBeNull();
    await expect(repository.findById('chunk-5')).resolves.toBeNull();
    await expect(repository.clearAll()).resolves.toBe(1);
    await expect(repository.findAll()).resolves.toEqual([]);
  });

  it('returns grep candidates with Turso filters, ordering, and root metadata', async () => {
    await client.exec(
      `INSERT INTO roots (id, kind, display_name, path, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
      [
        'root-a',
        'path',
        'Root A',
        '/workspace/root-a',
        'live',
        '2026-06-23T07:00:00.000Z',
        'root-b',
        'path',
        'Root B',
        '/workspace/root-b',
        'live',
        '2026-06-23T07:00:00.000Z',
      ]
    );
    await fileRecordsRepository.createWithContent(
      createRecord({
        embeddingSetId: 'set-a',
        id: 'file-a',
        name: 'alpha.ts',
        path: 'src/alpha.ts',
      })
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ id: 'file-b', name: 'beta.ts', path: 'src/beta.ts' })
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ id: 'file-c', name: 'gamma.ts', path: 'src/gamma.ts' })
    );
    await client.exec('UPDATE file_records SET root_id = ? WHERE id = ?', ['root-a', 'file-a']);
    await client.exec('UPDATE file_records SET root_id = ? WHERE id = ?', ['root-b', 'file-b']);
    await client.exec('UPDATE file_records SET root_id = ? WHERE id = ?', ['root-a', 'file-c']);
    await repository.insertMany([
      createChunk({
        chunkIndex: 1,
        content: 'const answer = 42;\nconst answerAgain = answer;',
        fileRecordId: 'file-a',
        id: 'chunk-a',
        startLine: 10,
      }),
      createChunk({
        content: 'const Answer = 99;',
        embeddingSetId: 'set-a',
        fileRecordId: 'file-b',
        id: 'chunk-b',
        startLine: 3,
      }),
      createChunk({
        content: 'const answer = 100;',
        embeddingSetId: 'set-b',
        fileRecordId: 'file-c',
        id: 'chunk-c',
        startLine: 1,
      }),
      createChunk({
        chunkIndex: 2,
        content: 'const percent = "100%_done";',
        embeddingSetId: 'set-a',
        fileRecordId: 'file-a',
        id: 'chunk-d',
        startLine: 20,
      }),
    ]);

    await expect(
      repository.findGrepCandidates({
        caseSensitive: false,
        embeddingSetId: 'set-a',
        filePaths: ['src/beta.ts', 'src/alpha.ts'],
        likePattern: 'answer',
        limit: 10,
        rootId: 'root-a',
      })
    ).resolves.toEqual([
      {
        content: 'const answer = 42;\nconst answerAgain = answer;',
        filePath: 'src/alpha.ts',
        rootId: 'root-a',
        rootName: 'Root A',
        startLine: 10,
      },
    ]);

    await expect(
      repository.findGrepCandidates({
        caseSensitive: true,
        likePattern: 'answer',
        limit: 10,
      })
    ).resolves.toEqual([
      expect.objectContaining({ filePath: 'src/alpha.ts' }),
      expect.objectContaining({ filePath: 'src/gamma.ts' }),
    ]);

    await expect(
      repository.findGrepCandidates({
        caseSensitive: false,
        likePattern: 'answer',
        limit: 1,
      })
    ).resolves.toHaveLength(1);
    await expect(
      repository.findGrepCandidates({
        caseSensitive: false,
        likePattern: '100\\%\\_done',
        limit: 10,
      })
    ).resolves.toEqual([expect.objectContaining({ filePath: 'src/alpha.ts', startLine: 20 })]);
    await expect(
      repository.findGrepCandidates({
        caseSensitive: false,
        filePaths: [],
        likePattern: 'answer',
        limit: 10,
      })
    ).resolves.toEqual([]);
  });

  it('runs bounded Turso grep candidate scans when no prefilter literal is available', async () => {
    await fileRecordsRepository.createWithContent(createRecord({ id: 'file-1' }));
    await fileRecordsRepository.createWithContent(
      createRecord({ id: 'file-2', name: 'two.ts', path: 'src/two.ts' })
    );
    await repository.insertMany([
      createChunk({ chunkIndex: 1, fileRecordId: 'file-1', id: 'chunk-2' }),
      createChunk({ chunkIndex: 0, fileRecordId: 'file-1', id: 'chunk-1' }),
      createChunk({ fileRecordId: 'file-2', id: 'chunk-3' }),
    ]);

    await expect(
      repository.findGrepCandidates({
        caseSensitive: false,
        likePattern: null,
        limit: 2,
      })
    ).resolves.toEqual([
      expect.objectContaining({ filePath: 'src/index.ts', startLine: null }),
      expect.objectContaining({ filePath: 'src/index.ts', startLine: null }),
    ]);
  });

  it('maintains a Turso grep content index for chunk insert, update, and delete', async () => {
    await fileRecordsRepository.createWithContent(createRecord({ id: 'file-1' }));

    await repository.insert(
      createChunk({
        content: 'Alpha Beta',
        id: 'chunk-1',
      })
    );

    await expect(readChunkContentIndex(client, 'chunk-1')).resolves.toEqual({
      normalized_content: 'alpha beta',
    });
    await expect(readChunkContentGrams(client, 'chunk-1', 0)).resolves.toEqual(
      expect.arrayContaining([{ gram: 'alp' }, { gram: 'bet' }])
    );
    await expect(readChunkContentGrams(client, 'chunk-1', 1)).resolves.toEqual(
      expect.arrayContaining([{ gram: 'Alp' }, { gram: 'Bet' }])
    );

    await repository.update({
      content: 'Gamma Delta',
      contentHash: 'hash-gamma-delta',
      id: 'chunk-1',
      updatedAt: '2026-06-23T08:50:00.000Z',
    });

    await expect(readChunkContentIndex(client, 'chunk-1')).resolves.toEqual({
      normalized_content: 'gamma delta',
    });
    await expect(readChunkContentGrams(client, 'chunk-1', 0)).resolves.toEqual(
      expect.arrayContaining([{ gram: 'gam' }, { gram: 'del' }])
    );
    await expect(readChunkContentGrams(client, 'chunk-1', 0)).resolves.not.toEqual(
      expect.arrayContaining([{ gram: 'alp' }])
    );

    await repository.delete('chunk-1');

    await expect(readChunkContentIndex(client, 'chunk-1')).resolves.toBeUndefined();
    await expect(readChunkContentGrams(client, 'chunk-1', 0)).resolves.toEqual([]);
  });

  it('rolls back public content updates when Turso grep index maintenance fails', async () => {
    await fileRecordsRepository.createWithContent(createRecord({ id: 'file-1' }));
    await repository.insert(
      createChunk({
        content: 'Alpha Beta',
        contentHash: 'hash-alpha-beta',
        id: 'chunk-1',
      })
    );
    await client.exec(`
      CREATE TRIGGER fail_grep_content_index_insert
      BEFORE INSERT ON file_chunk_content_index
      BEGIN
        SELECT RAISE(ABORT, 'forced grep content index failure');
      END
    `);

    await expect(
      repository.update({
        content: 'Gamma Delta',
        contentHash: 'hash-gamma-delta',
        id: 'chunk-1',
        updatedAt: '2026-06-23T08:55:00.000Z',
      })
    ).rejects.toThrow('forced grep content index failure');

    await expect(repository.findById('chunk-1')).resolves.toMatchObject({
      content: 'Alpha Beta',
      contentHash: 'hash-alpha-beta',
    });
    await expect(readChunkContentIndex(client, 'chunk-1')).resolves.toEqual({
      normalized_content: 'alpha beta',
    });
    await expect(readChunkContentGrams(client, 'chunk-1', 0)).resolves.toEqual(
      expect.arrayContaining([{ gram: 'alp' }])
    );
    await expect(readChunkContentGrams(client, 'chunk-1', 0)).resolves.not.toEqual(
      expect.arrayContaining([{ gram: 'gam' }])
    );
  });

  it('rejects unsafe Turso grep candidate limits before they reach SQLite LIMIT', async () => {
    await fileRecordsRepository.createWithContent(createRecord({ id: 'file-1' }));
    await repository.insert(createChunk({ id: 'chunk-1' }));

    await expect(
      repository.findGrepCandidates({
        caseSensitive: false,
        likePattern: 'answer',
        limit: -1,
      })
    ).rejects.toThrow('Invalid grep candidate limit: -1');
    await expect(
      repository.findGrepCandidates({
        caseSensitive: false,
        likePattern: 'answer',
        limit: 501,
      })
    ).rejects.toThrow('grep candidate limit 501 exceeds maximum 500');
  });

  it('selects literal grep candidates from the Turso content gram index', async () => {
    let capturedSql = '';
    let capturedParams: readonly unknown[] = [];
    const indexedRepository = new TursoFileChunkRepository({
      exec: vi.fn(async () => {}),
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        capturedSql = sql;
        capturedParams = params ?? [];
        return { rows: [] };
      }),
      transaction: vi.fn(async () => {
        throw new Error('findGrepCandidates should not open a transaction');
      }),
    });

    await indexedRepository.findGrepCandidates({
      caseSensitive: false,
      likePattern: 'Needle',
      limit: 10,
    });

    expect(capturedSql).toContain('FROM file_chunk_content_grams gc');
    expect(capturedSql).toContain('JOIN file_chunk_content_index fci');
    expect(capturedSql).toContain('instr(fci.normalized_content, ?)');
    expect(capturedSql).not.toContain('lower(fc.content)');
    expect(capturedParams).toEqual(expect.arrayContaining(['nee', 'eed', 'edl', 'dle', 0, 4]));

    const plan = await client.query<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${capturedSql}`,
      capturedParams
    );
    const planDetails = plan.rows.map((row) => row.detail).join('\n');
    expect(planDetails).toContain('file_chunk_content_grams');
    expect(planDetails).not.toMatch(/\bSCAN file_chunks\b/);
  });

  it('uses native Turso vector top-k SQL for similarity search', async () => {
    const capturedSearchQueries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const indexedRepository = new TursoFileChunkRepository({
      exec: vi.fn(async () => {}),
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes('FROM embedding_sets')) {
          return { rows: [{ dimensions: 3, distance: 'cosine' }] };
        }
        capturedSearchQueries.push({ sql, params: params ?? [] });
        return { rows: [] };
      }),
      transaction: vi.fn(async () => {
        throw new Error('searchSimilar should not open a transaction');
      }),
    });

    await indexedRepository.searchSimilar([1, 0, 0], {
      embeddingSetId: 'set-native',
      limit: 7,
      threshold: 0.2,
    });

    const searchSql = capturedSearchQueries[0]?.sql ?? '';
    expect(searchSql).toContain('WITH query_vector(value) AS (SELECT vector32(?))');
    expect(searchSql).toContain('vector_distance_cos(fc.embedding, q.value)');
    expect(searchSql).toContain('ORDER BY distance ASC');
    expect(searchSql).toContain('LIMIT ?');
    expect(searchSql).not.toContain('ORDER BY fc.id');
    expect(capturedSearchQueries[0]?.params[0]).toBe('[1,0,0]');
  });

  it.each([
    ['cosine', 'vector_distance_cos(fc.embedding, q.value)', '1.0 - ('],
    ['l2', 'vector_distance_l2(fc.embedding, q.value)', '1.0 / (1.0 +'],
    ['ip', 'vector_distance_dot(fc.embedding, q.value)', '1.0 / (1.0 + exp('],
  ] as const)('uses the Turso %s distance primitive for similarity search', async (distance, distanceExpression, similarityExpression) => {
    let capturedSql = '';
    const indexedRepository = new TursoFileChunkRepository({
      exec: vi.fn(async () => {}),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM embedding_sets')) {
          return { rows: [{ dimensions: 3, distance }] };
        }
        capturedSql = sql;
        return { rows: [] };
      }),
      transaction: vi.fn(async () => {
        throw new Error('searchSimilar should not open a transaction');
      }),
    });

    await indexedRepository.searchSimilar([1, 0, 0], {
      embeddingSetId: `set-${distance}`,
      limit: 3,
    });

    expect(capturedSql).toContain(distanceExpression);
    expect(capturedSql).toContain(similarityExpression);
  });

  it('searches stored Turso embeddings with set, threshold, root, and path filters', async () => {
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:small',
      'small',
      3,
      'cosine'
    );
    const otherEmbeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test:other',
      'other',
      3,
      'cosine'
    );
    await client.exec(
      `INSERT INTO roots (id, kind, display_name, path, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
      [
        'root-a',
        'path',
        'Root A',
        '/workspace/root-a',
        'live',
        '2026-06-23T07:00:00.000Z',
        'root-b',
        'path',
        'Root B',
        '/workspace/root-b',
        'live',
        '2026-06-23T07:00:00.000Z',
      ]
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: embeddingSet.id, id: 'file-a', path: 'src/alpha.ts' })
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: embeddingSet.id, id: 'file-b', path: 'src/beta.ts' })
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: embeddingSet.id, id: 'file-c', path: 'src/gamma.ts' })
    );
    await client.exec('UPDATE file_records SET root_id = ? WHERE id IN (?, ?)', [
      'root-a',
      'file-a',
      'file-b',
    ]);
    await client.exec('UPDATE file_records SET root_id = ? WHERE id = ?', ['root-b', 'file-c']);
    await repository.insertMany([
      createChunk({
        chunkIndex: 0,
        content: 'near',
        embedding: [1, 0, 0],
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-a',
        id: 'chunk-near',
      }),
      createChunk({
        chunkIndex: 0,
        content: 'mid',
        embedding: [0.8, 0.6, 0],
        fileRecordId: 'file-b',
        id: 'chunk-mid',
      }),
      createChunk({
        chunkIndex: 1,
        content: 'far',
        embedding: [0, 1, 0],
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-b',
        id: 'chunk-far',
      }),
      createChunk({
        chunkIndex: 2,
        content: 'opposite',
        embedding: [-1, 0, 0],
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-b',
        id: 'chunk-opposite',
      }),
      createChunk({
        chunkIndex: 0,
        content: 'wrong root',
        embedding: [0.99, 0.1, 0],
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-c',
        id: 'chunk-wrong-root',
      }),
      createChunk({
        chunkIndex: 1,
        content: 'wrong set',
        embedding: [1, 0, 0],
        embeddingSetId: otherEmbeddingSet.id,
        fileRecordId: 'file-a',
        id: 'chunk-wrong-set',
      }),
      createChunk({
        chunkIndex: 2,
        content: 'pending',
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-a',
        id: 'chunk-pending',
      }),
    ]);

    await expect(
      repository.searchSimilar([1, 0, 0], {
        embeddingSetId: embeddingSet.id,
        limit: 2,
        rootId: 'root-a',
        threshold: 0.75,
      })
    ).resolves.toEqual([
      {
        chunk: expect.objectContaining({
          embeddingDimensions: 3,
          embeddingSetId: embeddingSet.id,
          id: 'chunk-near',
        }),
        rank: 1,
        similarity: expect.closeTo(1, 6),
      },
      {
        chunk: expect.objectContaining({
          embeddingDimensions: 3,
          id: 'chunk-mid',
        }),
        rank: 2,
        similarity: expect.closeTo(0.9, 6),
      },
    ]);

    await client.exec(
      `INSERT INTO selection_snapshots (id, created_at, expires_at)
       VALUES (?, ?, ?)`,
      ['selection-beta', '2026-06-23T07:00:00.000Z', '2999-01-01T00:00:00.000Z']
    );
    await client.exec(
      `INSERT INTO selection_snapshot_files (snapshot_id, file_path)
       VALUES (?, ?)`,
      ['selection-beta', 'src/beta.ts']
    );

    const ranked = await repository.searchSimilar([1, 0, 0], {
      embeddingSetId: embeddingSet.id,
      filePaths: ['src/beta.ts'],
      includeEmbedding: true,
      limit: 5,
      selectionSnapshotId: 'selection-beta',
      threshold: 0.5,
    });
    expect(ranked.map((result) => result.chunk.id)).toEqual(['chunk-mid', 'chunk-far']);
    expect(ranked[0]?.chunk.embedding).toEqual([0.8, 0.6, 0]);
    expect(ranked[0]?.similarity).toEqual(expect.closeTo(0.9, 6));
    expect(ranked[1]?.similarity).toEqual(expect.closeTo(0.5, 6));

    await expect(
      repository.searchSimilar([1, 0], { embeddingSetId: embeddingSet.id })
    ).rejects.toThrow(
      `Query embedding dimension mismatch: received 2, expected 3 for embedding set ${embeddingSet.id}.`
    );
  });

  it('searches stored Turso embeddings with live L2 distance semantics', async () => {
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet('test:l2', 'l2', 3, 'l2');
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: embeddingSet.id, id: 'file-l2', path: 'src/l2.ts' })
    );
    await repository.insertMany([
      createChunk({
        chunkIndex: 0,
        content: 'same',
        embedding: [1, 0, 0],
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-l2',
        id: 'chunk-l2-same',
      }),
      createChunk({
        chunkIndex: 1,
        content: 'one away',
        embedding: [0, 0, 0],
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-l2',
        id: 'chunk-l2-one-away',
      }),
    ]);

    const results = await repository.searchSimilar([1, 0, 0], {
      embeddingSetId: embeddingSet.id,
      limit: 5,
      threshold: 0,
    });

    expect(results.map((result) => result.chunk.id)).toEqual([
      'chunk-l2-same',
      'chunk-l2-one-away',
    ]);
    expect(results[0]?.similarity).toEqual(expect.closeTo(1, 6));
    expect(results[1]?.similarity).toEqual(expect.closeTo(0.5, 6));
  });

  it('searches stored Turso embeddings with live inner-product sign semantics', async () => {
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet('test:ip', 'ip', 3, 'ip');
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: embeddingSet.id, id: 'file-ip', path: 'src/ip.ts' })
    );
    await repository.insertMany([
      createChunk({
        chunkIndex: 0,
        content: 'largest dot',
        embedding: [2, 0, 0],
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-ip',
        id: 'chunk-ip-largest',
      }),
      createChunk({
        chunkIndex: 1,
        content: 'middle dot',
        embedding: [0.5, 0, 0],
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-ip',
        id: 'chunk-ip-middle',
      }),
      createChunk({
        chunkIndex: 2,
        content: 'negative dot',
        embedding: [-2, 0, 0],
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-ip',
        id: 'chunk-ip-negative',
      }),
    ]);

    const results = await repository.searchSimilar([1, 0, 0], {
      embeddingSetId: embeddingSet.id,
      limit: 5,
      threshold: 0,
    });

    expect(results.map((result) => result.chunk.id)).toEqual([
      'chunk-ip-largest',
      'chunk-ip-middle',
      'chunk-ip-negative',
    ]);
    expect(results[0]?.similarity).toEqual(expect.closeTo(0.880_797, 6));
    expect(results[1]?.similarity).toEqual(expect.closeTo(0.622_459, 6));
    expect(results[2]?.similarity).toEqual(expect.closeTo(0.119_203, 6));
  });

  it('runs indexed lexical search over Turso chunk content', async () => {
    await fileRecordsRepository.createWithContent(
      createRecord({
        embeddingSetId: 'set-a',
        id: 'file-auth',
        name: 'auth.ts',
        path: 'src/auth.ts',
      })
    );
    await fileRecordsRepository.createWithContent(
      createRecord({
        embeddingSetId: 'set-a',
        id: 'file-avatar',
        name: 'avatar.ts',
        path: 'src/avatar.ts',
      })
    );
    await repository.insertMany([
      createChunk({
        chunkType: 'code',
        content:
          'export function authenticateLoginToken() { return "<script> login authentication"; }',
        fileRecordId: 'file-auth',
        id: 'chunk-auth',
      }),
      createChunk({
        chunkType: 'code',
        content: 'export function renderAvatar() { return "profile image"; }',
        fileRecordId: 'file-avatar',
        id: 'chunk-avatar',
      }),
    ]);

    const results = await repository.fullTextSearch('authentication login', {
      chunkType: 'code',
      filePaths: ['src/auth.ts'],
      includeHeadline: true,
      limit: 5,
      threshold: 0,
    });

    expect(results).toEqual([
      expect.objectContaining({
        chunk: expect.objectContaining({
          fileRecordId: 'file-auth',
          id: 'chunk-auth',
        }),
        headline: expect.stringContaining('<mark>authentication</mark>'),
        position: 1,
        rank: expect.any(Number),
      }),
    ]);
    expect(results[0]?.chunk.embedding).toBeUndefined();
    expect(results[0]?.headline).toContain('&lt;script&gt;');
    expect(results[0]?.headline).not.toContain('<script>');
  });
});

function createRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    content: 'const answer = 42;',
    contentHash: 'hash-file-1',
    createdAt: '2026-06-23T08:00:00.000Z',
    id: 'file-1',
    name: 'index.ts',
    path: 'src/index.ts',
    size: 42,
    tokenCount: 8,
    updatedAt: '2026-06-23T08:00:00.000Z',
    ...overrides,
  };
}

function createChunk(overrides: Partial<FileChunkInsert> = {}): FileChunkInsert {
  return {
    chunkIndex: 0,
    chunkSize: 18,
    chunkType: 'code',
    content: 'const answer = 42;',
    contentHash: 'hash-chunk-1',
    createdAt: '2026-06-23T08:10:00.000Z',
    fileRecordId: 'file-1',
    id: 'chunk-1',
    tokenCount: 4,
    updatedAt: '2026-06-23T08:10:00.000Z',
    ...overrides,
  };
}

async function insertRawEmbeddingJob(
  client: TursoOwnerClient,
  input: {
    chunkId: string;
    dedupeKey: string;
    embeddingSetId: string | null;
    id: string;
    state: 'failed' | 'queued' | 'running' | 'succeeded';
  }
): Promise<void> {
  await client.exec(
    `INSERT INTO job_queue (
       id,
       queue,
       job_type,
       payload,
       chunk_id,
       embedding_set_id,
       state,
       dedupe_key,
       created_at,
       updated_at
     )
     VALUES (?, 'embeddings', 'embed_chunk', ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      JSON.stringify({ chunkId: input.chunkId, embeddingSetId: input.embeddingSetId }),
      input.chunkId,
      input.embeddingSetId,
      input.state,
      input.dedupeKey,
      '2026-06-23T08:20:00.000Z',
      '2026-06-23T08:20:00.000Z',
    ]
  );
}

async function readChunkContentIndex(
  client: TursoOwnerClient,
  fileChunkId: string
): Promise<{ normalized_content: string } | undefined> {
  const result = await client.query<{ normalized_content: string }>(
    'SELECT normalized_content FROM file_chunk_content_index WHERE file_chunk_id = ?',
    [fileChunkId]
  );
  return result.rows[0];
}

async function readChunkContentGrams(
  client: TursoOwnerClient,
  fileChunkId: string,
  caseSensitive: 0 | 1
): Promise<readonly { gram: string }[]> {
  const result = await client.query<{ gram: string }>(
    `SELECT gram
       FROM file_chunk_content_grams
      WHERE file_chunk_id = ?
        AND case_sensitive = ?
      ORDER BY gram`,
    [fileChunkId, caseSensitive]
  );
  return result.rows;
}
