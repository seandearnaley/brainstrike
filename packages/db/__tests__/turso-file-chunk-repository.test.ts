import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainstrikeDbExecutionClient } from '../src/architecture/brainstrike-db-client-contract.js';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import type { FileRecord } from '../src/models/file-record.js';
import { buildEmbeddingJobDedupeKey } from '../src/queue/embedding-job-dedupe-key.js';
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
    const fakeDb: BrainstrikeDbExecutionClient = {
      exec: vi.fn(async () => {}),
      query: vi.fn(async (sql: string) => {
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
      }),
      transaction: vi.fn(async () => {
        throw new Error('update should not open a transaction');
      }),
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
      createChunk({ chunkIndex: 1, id: 'chunk-2', tokenCount: 7 }),
    ]);

    await expect(repository.getStats()).resolves.toEqual({
      averageTokenCount: 6,
      chunkTypeDistribution: { code: 2 },
      chunksWithEmbeddings: 1,
      totalChunks: 2,
    });
    await expect(repository.getCoverageForSet(embeddingSet.id)).resolves.toEqual({
      chunksWithEmbeddingsForSet: 1,
      totalChunks: 2,
    });

    await expect(repository.clearEmbeddingsForSet(embeddingSet.id)).resolves.toBe(1);
    const clearedChunk = await repository.findById('chunk-1');
    expect(clearedChunk).toMatchObject({ embeddingSetId: embeddingSet.id });
    expect(clearedChunk).not.toHaveProperty('embedding');
    expect(clearedChunk).not.toHaveProperty('embeddingHash');
    expect(clearedChunk).not.toHaveProperty('embeddingUpdatedAt');
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
          chunk_count: 1,
          dirty: 0,
          embedded_chunk_count: 0,
          file_count: 1,
          pending_chunk_count: 1,
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

  it('throws explicit unsupported errors for search methods not yet ported to Turso', async () => {
    await expect(repository.searchSimilar([0.1, 0.2, 0.3])).rejects.toThrow(
      'TursoFileChunkRepository.searchSimilar requires the Turso vector search slice.'
    );
    await expect(repository.fullTextSearch('answer')).rejects.toThrow(
      'TursoFileChunkRepository.fullTextSearch requires the Turso FTS search slice.'
    );
    await expect(
      repository.findGrepCandidates({
        caseSensitive: false,
        likePattern: 'answer',
        limit: 10,
      })
    ).rejects.toThrow(
      'TursoFileChunkRepository.findGrepCandidates requires the Turso grep search slice.'
    );
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
