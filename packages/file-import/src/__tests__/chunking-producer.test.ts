import type { PortableChunk } from '@brainstrike/chunking-worker';
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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processChunking } from '../chunking';
import type { ChunkingWorkerPort } from '../chunking-worker-port';

// Helper to create a mock worker port for tests
function createMockPortableChunk(overrides: Partial<PortableChunk> = {}): PortableChunk {
  return {
    chunkIndex: 0,
    content: '# Title\ncontent here',
    contentHash: 'hash-1',
    tokenCount: 5,
    chunkType: 'sentence',
    chunkSize: 20,
    startLine: 1,
    endLine: 2,
    startOffset: 0,
    endOffset: 20,
    ...overrides,
  };
}

function createMockChunkingWorkerPort(): ChunkingWorkerPort {
  return {
    transportKind: 'local-worker',
    isReady: vi.fn().mockReturnValue(true),
    terminate: vi.fn(),
    chunkFile: vi.fn().mockResolvedValue({
      fileRecordId: 'file-1',
      chunks: [createMockPortableChunk()],
      strategyUsed: 'sentence',
      totalTokens: 5,
      skipped: false,
    }),
    chunkBatch: vi.fn().mockResolvedValue([]),
  };
}

describe('Chunking producer enqueues jobs', () => {
  // Increase timeouts to tolerate in-memory DB startup + migrations under load
  vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://chunking-producer');
    await migrate(db);
  });

  it('enqueues one embed_chunk job per chunk after insertMany when enabled', async () => {
    const fileRepo = new FileRecordRepository(db);
    const chunkRepo = new FileChunkRepository(db);

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

    const mockWorkerPort = createMockChunkingWorkerPort();

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
        chunkingWorkerPort: mockWorkerPort,
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

    expect(results[0]?.chunksCreated).toBeGreaterThan(0);
    const countRes = await db.query<{ count: string }>('SELECT COUNT(*) AS count FROM job_queue');
    const jobCount = Number(countRes.rows[0]?.count);
    expect(jobCount).toBe(results[0]?.chunksCreated);
    expect(enqueuedIds.length).toBe(jobCount);
  });
});
