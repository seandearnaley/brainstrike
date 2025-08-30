import type { FileImportResult, FileRecord } from '@brainstrike/db';
import {
  FileChunkRepository,
  FileRecordRepository,
  JobQueue,
  migrate,
  wasmLoader,
} from '@brainstrike/db';
import { generateUUID } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processChunking } from '../chunking';

describe('Chunking producer enqueues jobs', () => {
  beforeAll(() => {
    process.env.DISABLE_VECTOR_EXTENSION = 'true';
  });
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://chunking-producer');
    await migrate(db);
  });

  it('enqueues one embed_chunk job per chunk after insertMany when enabled', async () => {
    const fileRepo = new FileRecordRepository(db);
    const chunkRepo = new FileChunkRepository(db, false);

    const now = new Date().toISOString();
    // Create a file record with content
    const fileId = generateUUID();
    const record: FileRecord = {
      id: fileId,
      name: 'test.md',
      path: '/test.md',
      size: 12,
      createdAt: now,
      updatedAt: now,
      content: '# Title\ncontent here',
      contentHash: 'hash123',
      tokenCount: 3,
      processedAt: now,
    };
    await fileRepo.createWithContent(record);

    const importResults: FileImportResult[] = [{ id: fileId, imported: true, existed: false }];

    const jobQueue = new JobQueue(db);
    const enqueuedIds: string[] = [];

    const results = await processChunking(
      importResults,
      {
        repository: fileRepo as unknown as ReturnType<
          typeof import('@brainstrike/db').useFileRecordRepository
        >,
        chunkRepository: chunkRepo as unknown as ReturnType<
          typeof import('@brainstrike/db').useFileChunkRepository
        >,
      },
      {
        updateProgress: () => null,
        embedQueueEnabled: true,
        enqueueJobsForChunks: async (chunks, fileRecordId) => {
          for (const ch of chunks) {
            const dedupeKey = `${ch.id}:${ch.embeddingSetId ?? 'none'}:${ch.contentHash}`;
            const job = await jobQueue.enqueue({
              queue: 'embeddings',
              jobType: 'embed_chunk',
              payload: { chunkId: ch.id, fileRecordId, embeddingSetId: ch.embeddingSetId ?? null },
              dedupeKey,
            });
            enqueuedIds.push(job.id);
          }
        },
      }
    );

    expect(results[0].chunksCreated).toBeGreaterThan(0);
    const countRes = await db.query<{ count: string }>('SELECT COUNT(*) AS count FROM job_queue');
    const jobCount = Number(countRes.rows[0].count);
    expect(jobCount).toBe(results[0].chunksCreated);
    expect(enqueuedIds.length).toBe(jobCount);
  });
});
