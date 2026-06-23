import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type InsertChunksAndEnqueueEmbeddingJobsArgs,
  insertTursoChunksAndEnqueueEmbeddingJobs,
} from '../src/chunk-embedding-job-batch.js';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import type { FileRecord } from '../src/models/file-record.js';
import { TursoEmbeddingSetsRepository } from '../src/repositories/turso-embedding-sets-repository.js';
import { TursoFileRecordRepository } from '../src/repositories/turso-file-record-repository.js';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import { applyTursoSchemaBaseline } from '../src/turso/schema-baseline.js';

describe('Turso JobQueue transactional enqueue', () => {
  let client: TursoOwnerClient;
  let embeddingSetsRepository: TursoEmbeddingSetsRepository;
  let embeddingSetId: string;
  let fileRecordsRepository: TursoFileRecordRepository;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-job-queue-tx-'));
    client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
    await applyTursoSchemaBaseline(client);
    embeddingSetsRepository = new TursoEmbeddingSetsRepository(client);
    fileRecordsRepository = new TursoFileRecordRepository(client);
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'local::test-model',
      'test-model',
      384,
      'cosine'
    );
    embeddingSetId = embeddingSet.id;
    await fileRecordsRepository.createWithContent(createRecord({ id: 'file-1' }));
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('inserts chunks and enqueues embedding jobs in one Turso owner transaction', async () => {
    await insertTursoChunksAndEnqueueEmbeddingJobs(client, createArgs());

    await expect(countRows('file_chunks', "id = 'chunk-1'")).resolves.toBe(1);
    await expect(
      client.query<{
        chunk_id: string;
        embedding_set_id: string;
        expectedDimension: number;
        job_type: string;
        modelKey: string;
        state: string;
      }>(
        `SELECT
           chunk_id,
           embedding_set_id,
           job_type,
           json_extract(payload, '$.expectedDimension') AS expectedDimension,
           json_extract(payload, '$.modelKey') AS modelKey,
           state
         FROM job_queue
         WHERE job_type = 'embed_chunk'`
      )
    ).resolves.toEqual({
      rows: [
        {
          chunk_id: 'chunk-1',
          embedding_set_id: embeddingSetId,
          expectedDimension: 384,
          job_type: 'embed_chunk',
          modelKey: 'local::test-model',
          state: 'queued',
        },
      ],
    });
  });

  it('rolls back inserted Turso chunks when embedding job enqueue validation fails', async () => {
    await fileRecordsRepository.createWithContent(createRecord({ id: 'file-2' }));

    await expect(
      insertTursoChunksAndEnqueueEmbeddingJobs(
        client,
        createArgs({ chunks: [createChunk({ fileRecordId: 'file-2' })] })
      )
    ).rejects.toThrow(
      "Cannot enqueue embedding job for chunk 'chunk-1' with mismatched file record id."
    );

    await expect(countRows('file_chunks', "id = 'chunk-1'")).resolves.toBe(0);
    await expect(countRows('job_queue', "job_type = 'embed_chunk'")).resolves.toBe(0);
  });

  it('reuses the active embedding job for repeated Turso chunk upserts with the same dedupe key', async () => {
    await insertTursoChunksAndEnqueueEmbeddingJobs(client, createArgs());
    await insertTursoChunksAndEnqueueEmbeddingJobs(
      client,
      createArgs({ chunks: [createChunk({ content: 'const answer = 43;' })] })
    );

    await expect(countRows('file_chunks', "id = 'chunk-1'")).resolves.toBe(1);
    await expect(countRows('job_queue', "job_type = 'embed_chunk'")).resolves.toBe(1);
  });

  it('enforces active Turso dedupe keys at the database boundary', async () => {
    await insertRawJob('job-1', 'queued', 'dedupe-1');

    await expect(insertRawJob('job-2', 'queued', 'dedupe-1')).rejects.toThrow();
    await insertRawJob('job-3', 'succeeded', 'dedupe-1');
    await insertRawJob('job-4', 'queued', null);
    await insertRawJob('job-5', 'queued', null);

    await expect(countRows('job_queue', "dedupe_key = 'dedupe-1'")).resolves.toBe(2);
    await expect(countRows('job_queue', 'dedupe_key IS NULL')).resolves.toBe(2);
  });

  function createArgs(
    overrides: Partial<InsertChunksAndEnqueueEmbeddingJobsArgs> = {}
  ): InsertChunksAndEnqueueEmbeddingJobsArgs {
    return {
      chunks: [createChunk()],
      dimensionParameter: null,
      fileRecordId: 'file-1',
      model: 'local::test-model',
      provider: 'local',
      targetDimension: 384,
      targetEmbeddingSetId: embeddingSetId,
      ...overrides,
    };
  }

  async function countRows(tableName: 'file_chunks' | 'job_queue', where: string): Promise<number> {
    const result = await client.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM ${tableName} WHERE ${where}`
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function insertRawJob(
    id: string,
    state: 'queued' | 'running' | 'succeeded',
    dedupeKey: string | null
  ): Promise<void> {
    await client.exec(
      `INSERT INTO job_queue (
         id,
         queue,
         job_type,
         payload,
         state,
         dedupe_key,
         created_at,
         updated_at
       )
       VALUES (?, 'embeddings', 'embed_chunk', ?, ?, ?, ?, ?)`,
      [
        id,
        JSON.stringify({ chunkId: `chunk-${id}` }),
        state,
        dedupeKey,
        '2026-06-23T08:20:00.000Z',
        '2026-06-23T08:20:00.000Z',
      ]
    );
  }
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
