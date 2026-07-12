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
    chunkSize: 20,
    chunkType: 'sentence',
    content: '# Title\ncontent here',
    contentHash: 'hash-1',
    endLine: 2,
    endOffset: 20,
    startLine: 1,
    startOffset: 0,
    tokenCount: 5,
    ...overrides,
  };
}

function createMockChunkingWorkerPort(): ChunkingWorkerPort {
  return {
    chunkBatch: vi.fn().mockResolvedValue([]),
    chunkFile: vi.fn().mockResolvedValue({
      chunks: [createMockPortableChunk()],
      fileRecordId: 'file-1',
      skipped: false,
      strategyUsed: 'sentence',
      totalTokens: 5,
    }),
    isReady: vi.fn().mockReturnValue(true),
    terminate: vi.fn(),
    transportKind: 'local-worker',
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
      content: '# Title\ncontent here',
      contentHash: 'hash123',
      createdAt: now,
      id: fileId,
      name: 'test.md',
      path: '/test.md',
      processedAt: now,
      size: 12,
      tokenCount: 3,
      updatedAt: now,
    };
    await fileRepo.createWithContent(record);

    const importResults: FileImportResult[] = [{ existed: false, id: fileId, imported: true }];

    const jobQueue = new JobQueue(db);
    const enqueuedIds: string[] = [];

    const mockWorkerPort = createMockChunkingWorkerPort();

    const results = await processChunking(
      importResults,
      {
        chunkRepository: chunkRepo as unknown as ReturnType<
          typeof import('@brainstrike/db').useFileChunkRepository
        >,
        repository: fileRepo as unknown as ReturnType<
          typeof import('@brainstrike/db').useFileRecordRepository
        >,
      },
      {
        chunkingWorkerPort: mockWorkerPort,
        embedQueueEnabled: true,
        enqueueJobsForChunks: async (chunks, fileRecordId) => {
          for (const ch of chunks) {
            const dedupeKey = `${ch.id}:${ch.embeddingSetId ?? 'none'}:${ch.contentHash}`;
            const job = await jobQueue.enqueue({
              dedupeKey,
              jobType: 'embed_chunk',
              payload: { chunkId: ch.id, embeddingSetId: ch.embeddingSetId ?? null, fileRecordId },
              queue: 'embeddings',
            });
            enqueuedIds.push(job.id);
          }
        },
        updateProgress: () => null,
      }
    );

    expect(results[0]?.chunksCreated).toBeGreaterThan(0);
    const countRes = await db.query<{ count: string }>('SELECT COUNT(*) AS count FROM job_queue');
    const jobCount = Number(countRes.rows[0]?.count);
    expect(jobCount).toBe(results[0]?.chunksCreated);
    expect(enqueuedIds.length).toBe(jobCount);
  });
});
