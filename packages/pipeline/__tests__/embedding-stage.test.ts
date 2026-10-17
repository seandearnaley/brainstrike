/**
 * Tests for the embedding stage orchestrator.
 *
 * These tests verify:
 * - Single file chunk enqueue
 * - Batch enqueue with multiple files
 * - Progress tracking and callbacks
 * - Error isolation and continue-on-error behavior
 * - Dedupe key generation
 * - Chunk ID generation vs provided IDs
 * - Abort signal handling
 */

import { buildEmbedJobDedupeKey } from '@brainstrike/indexing-contract';
import { describe, expect, it } from 'vitest';
import {
  type ChunkOutput,
  type ContentHash,
  createEmbeddingStage,
  type EmbeddingEnqueueProgress,
  type EnqueueChunksInput,
  type EnqueuedJob,
  type EnqueueJobParams,
  type JobQueueLike,
  toChunkId,
  toEmbeddingSetId,
  toFileId,
} from '../src/index.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a mock job queue that tracks enqueue calls.
 */
function createMockJobQueue(
  options: { shouldFail?: boolean; failMessage?: string } = {}
): JobQueueLike & {
  enqueueCalls: EnqueueJobParams[];
  enqueuedJobs: EnqueuedJob[];
} {
  const enqueueCalls: EnqueueJobParams[] = [];
  const enqueuedJobs: EnqueuedJob[] = [];
  let jobCounter = 0;

  return {
    async enqueue(params: EnqueueJobParams): Promise<EnqueuedJob> {
      if (options.shouldFail) {
        throw new Error(options.failMessage ?? 'Mock enqueue failure');
      }

      enqueueCalls.push(params);
      const job: EnqueuedJob = {
        dedupeKey: params.dedupeKey ?? null,
        id: `job-${++jobCounter}` as EnqueuedJob['id'],
        jobType: params.jobType,
        queue: params.queue,
        state: 'queued',
      };
      enqueuedJobs.push(job);
      return job;
    },
    enqueueCalls,
    enqueuedJobs,
  };
}

/**
 * Create a mock job queue with batch support.
 */
function createMockJobQueueWithBatch(): JobQueueLike & {
  enqueueCalls: EnqueueJobParams[];
  batchCalls: EnqueueJobParams[][];
  enqueuedJobs: EnqueuedJob[];
} {
  const enqueueCalls: EnqueueJobParams[] = [];
  const batchCalls: EnqueueJobParams[][] = [];
  const enqueuedJobs: EnqueuedJob[] = [];
  let jobCounter = 0;

  return {
    batchCalls,
    async enqueue(params: EnqueueJobParams): Promise<EnqueuedJob> {
      enqueueCalls.push(params);
      const job: EnqueuedJob = {
        dedupeKey: params.dedupeKey ?? null,
        id: `job-${++jobCounter}` as EnqueuedJob['id'],
        jobType: params.jobType,
        queue: params.queue,
        state: 'queued',
      };
      enqueuedJobs.push(job);
      return job;
    },
    async enqueueBatch(params: EnqueueJobParams[]): Promise<EnqueuedJob[]> {
      batchCalls.push([...params]);
      return params.map((p) => {
        const job: EnqueuedJob = {
          dedupeKey: p.dedupeKey ?? null,
          id: `job-${++jobCounter}` as EnqueuedJob['id'],
          jobType: p.jobType,
          queue: p.queue,
          state: 'queued',
        };
        enqueuedJobs.push(job);
        return job;
      });
    },
    enqueueCalls,
    enqueuedJobs,
  };
}

/**
 * Create a sample chunk output for testing.
 */
function createSampleChunk(index: number, content = 'sample content'): ChunkOutput {
  return {
    chunkIndex: index,
    chunkSize: 512,
    chunkType: 'text',
    content,
    contentHash: `hash-${index}` as ContentHash,
    endLine: index + 1,
    endOffset: index + content.length,
    startLine: index + 1,
    startOffset: index,
    tokenCount: content.split(' ').length,
  };
}

/**
 * Create sample enqueue input.
 */
function createSampleInput(chunkCount = 3): EnqueueChunksInput {
  return {
    chunks: Array.from({ length: chunkCount }, (_, i) => createSampleChunk(i)),
    embeddingSetId: toEmbeddingSetId('550e8400-e29b-41d4-a716-446655440001'),
    fileId: toFileId('550e8400-e29b-41d4-a716-446655440000'),
  };
}

// =============================================================================
// BASIC FUNCTIONALITY TESTS
// =============================================================================

describe('createEmbeddingStage', () => {
  describe('basic functionality', () => {
    it('enqueues jobs for all chunks', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });

      const input = createSampleInput(3);
      const result = await stage.enqueueChunks(input);

      expect(result.jobsEnqueued).toBe(3);
      expect(result.chunkIds).toHaveLength(3);
      expect(result.jobIds).toHaveLength(3);
      expect(result.skipped).toBe(false);
      expect(jobQueue.enqueueCalls).toHaveLength(3);
    });

    it('generates unique chunk IDs when not provided', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });

      const input = createSampleInput(2);
      const result = await stage.enqueueChunks(input);

      expect(result.chunkIds).toHaveLength(2);
      expect(result.chunkIds[0]).not.toBe(result.chunkIds[1]);
      // Chunk IDs should be UUIDs
      expect(result.chunkIds[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('uses provided chunk IDs when available', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });

      const providedChunkIds = [
        toChunkId('11111111-1111-4111-8111-111111111111'),
        toChunkId('22222222-2222-4222-8222-222222222222'),
      ];
      const input = {
        ...createSampleInput(2),
        chunkIds: providedChunkIds,
      };
      const result = await stage.enqueueChunks(input);

      expect(result.chunkIds).toEqual(providedChunkIds);
    });

    it('handles empty chunks array', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });

      const input = {
        ...createSampleInput(0),
        chunks: [],
      };
      const result = await stage.enqueueChunks(input);

      expect(result.jobsEnqueued).toBe(0);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('No chunks to enqueue');
      expect(jobQueue.enqueueCalls).toHaveLength(0);
    });

    it('uses default model key when not specified', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({
        defaultModelKey: 'openai::text-embedding-3-small',
        jobQueue,
      });

      const input = createSampleInput(1);
      await stage.enqueueChunks(input);

      const payload = jobQueue.enqueueCalls[0]?.payload as { modelKey: string };
      expect(payload['modelKey']).toBe('openai::text-embedding-3-small');
    });

    it('uses provided model key over default', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({
        defaultModelKey: 'local::default-model',
        jobQueue,
      });

      const input = {
        ...createSampleInput(1),
        modelKey: 'openai::custom-model',
      };
      await stage.enqueueChunks(input);

      const payload = jobQueue.enqueueCalls[0]?.payload as { modelKey: string };
      expect(payload['modelKey']).toBe('openai::custom-model');
    });

    it('uses custom queue name when provided', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({
        jobQueue,
        queueName: 'custom-embeddings',
      });

      const input = createSampleInput(1);
      await stage.enqueueChunks(input);

      expect(jobQueue.enqueueCalls[0]?.queue).toBe('custom-embeddings');
    });
  });

  // =============================================================================
  // DEDUPE KEY TESTS
  // =============================================================================

  describe('dedupe keys', () => {
    it('generates the canonical dedupe key shared with the db enqueue path', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({
        defaultModelKey: 'openai::text-embedding-3-small',
        jobQueue,
      });

      const input = createSampleInput(1);
      const result = await stage.enqueueChunks(input);

      const chunkId = result.chunkIds[0];
      const contentHash = input.chunks[0]?.contentHash ?? '';
      expect(jobQueue.enqueueCalls[0]?.dedupeKey).toBe(
        buildEmbedJobDedupeKey(chunkId ?? '', input.embeddingSetId, contentHash)
      );
    });

    it('generates unique dedupe keys for different chunks', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });

      const input = createSampleInput(2);
      await stage.enqueueChunks(input);

      const dedupeKeys = jobQueue.enqueueCalls.map((call) => call.dedupeKey);
      expect(dedupeKeys[0]).not.toBe(dedupeKeys[1]);
    });
  });

  // =============================================================================
  // JOB PAYLOAD TESTS
  // =============================================================================

  describe('job payloads', () => {
    it('includes all required fields in payload', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({
        defaultModelKey: 'openai::test-model',
        expectedDimension: 1536,
        jobQueue,
      });

      const input = createSampleInput(1);
      const result = await stage.enqueueChunks(input);

      const payload = jobQueue.enqueueCalls[0]?.payload as Record<string, unknown>;
      expect(payload['chunkId']).toBe(result.chunkIds[0]);
      expect(payload['fileRecordId']).toBe(input.fileId);
      expect(payload['embeddingSetId']).toBe(input.embeddingSetId);
      expect(payload['modelKey']).toBe('openai::test-model');
      expect(payload['expectedDimension']).toBe(1536);
      expect(payload['contentHash']).toBe(input.chunks[0]?.contentHash);
      expect(payload['chunkIndex']).toBe(0);
    });

    it('uses job type embed_chunk', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });

      const input = createSampleInput(1);
      await stage.enqueueChunks(input);

      expect(jobQueue.enqueueCalls[0]?.jobType).toBe('embed_chunk');
    });
  });

  // =============================================================================
  // BATCH ENQUEUE TESTS
  // =============================================================================

  describe('batch enqueueBatch method', () => {
    it('uses batch enqueue when available', async () => {
      const jobQueue = createMockJobQueueWithBatch();
      const stage = createEmbeddingStage({ jobQueue });

      const input = createSampleInput(3);
      await stage.enqueueChunks(input);

      // Should use enqueueBatch, not individual enqueue
      expect(jobQueue.batchCalls).toHaveLength(1);
      expect(jobQueue.batchCalls[0]).toHaveLength(3);
      expect(jobQueue.enqueueCalls).toHaveLength(0);
    });

    it('falls back to individual enqueue when batch not available', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });

      const input = createSampleInput(3);
      await stage.enqueueChunks(input);

      expect(jobQueue.enqueueCalls).toHaveLength(3);
    });
  });

  // =============================================================================
  // BATCH PROCESSING TESTS
  // =============================================================================

  describe('enqueueBatch', () => {
    it('processes multiple files', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });

      const result = await stage.enqueueBatch({
        files: [
          createSampleInput(2),
          {
            ...createSampleInput(3),
            fileId: toFileId('660e8400-e29b-41d4-a716-446655440000'),
          },
        ],
      });

      expect(result.totalFiles).toBe(2);
      expect(result.successCount).toBe(2);
      expect(result.totalJobsEnqueued).toBe(5); // 2 + 3
      expect(result.results).toHaveLength(2);
    });

    it('aggregates results correctly', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });

      const result = await stage.enqueueBatch({
        files: [createSampleInput(2), createSampleInput(3), createSampleInput(1)],
      });

      expect(result.totalJobsEnqueued).toBe(6);
      expect(result.successCount).toBe(3);
      expect(result.errorCount).toBe(0);
    });

    it('handles empty files array', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });

      const result = await stage.enqueueBatch({ files: [] });

      expect(result.totalFiles).toBe(0);
      expect(result.successCount).toBe(0);
      expect(result.results).toHaveLength(0);
    });
  });

  // =============================================================================
  // PROGRESS TRACKING TESTS
  // =============================================================================

  describe('progress tracking', () => {
    it('calls progress callback during batch processing', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });
      const progressUpdates: EmbeddingEnqueueProgress[] = [];

      await stage.enqueueBatch({
        files: [createSampleInput(2), createSampleInput(3)],
        onProgress: (p) => progressUpdates.push({ ...p }),
      });

      expect(progressUpdates.length).toBeGreaterThan(0);
      // Final update should show completion
      const final = progressUpdates.at(-1);
      expect(final?.completedFiles).toBe(2);
      expect(final?.totalJobsEnqueued).toBe(5);
    });

    it('tracks elapsed time', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });
      let capturedElapsed = 0;

      await stage.enqueueBatch({
        files: [createSampleInput(1)],
        onProgress: (p) => {
          capturedElapsed = p.elapsedMs;
        },
      });

      expect(capturedElapsed).toBeGreaterThanOrEqual(0);
    });

    it('includes current file in progress', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });
      const fileIds: (string | undefined)[] = [];

      await stage.enqueueBatch({
        files: [createSampleInput(1), createSampleInput(1)],
        onProgress: (p) => {
          if (p.currentFile) {
            fileIds.push(p.currentFile);
          }
        },
      });

      expect(fileIds.length).toBeGreaterThan(0);
    });
  });

  // =============================================================================
  // ERROR HANDLING TESTS
  // =============================================================================

  describe('error handling', () => {
    it('isolates errors to individual files by default', async () => {
      let callCount = 0;
      const jobQueue: JobQueueLike = {
        async enqueue(params) {
          callCount++;
          if (callCount === 2) {
            throw new Error('Second file failed');
          }
          return {
            dedupeKey: params.dedupeKey ?? null,
            id: `job-${callCount}` as EnqueuedJob['id'],
            jobType: params.jobType,
            queue: params.queue,
            state: 'queued',
          };
        },
      };
      const stage = createEmbeddingStage({ jobQueue });

      const result = await stage.enqueueBatch({
        files: [
          createSampleInput(1),
          createSampleInput(1), // This one will fail
          createSampleInput(1),
        ],
      });

      expect(result.successCount).toBe(2);
      expect(result.errorCount).toBe(1);
      expect(result.results).toHaveLength(3);
    });

    it('stops on first error when continueOnError is false', async () => {
      let callCount = 0;
      const jobQueue: JobQueueLike = {
        async enqueue(params) {
          callCount++;
          if (callCount === 2) {
            throw new Error('Stop here');
          }
          return {
            dedupeKey: params.dedupeKey ?? null,
            id: `job-${callCount}` as EnqueuedJob['id'],
            jobType: params.jobType,
            queue: params.queue,
            state: 'queued',
          };
        },
      };
      const stage = createEmbeddingStage({ jobQueue });

      const result = await stage.enqueueBatch({
        continueOnError: false,
        files: [createSampleInput(1), createSampleInput(1), createSampleInput(1)],
      });

      // Should have stopped after second file failed
      expect(result.results.length).toBe(2);
      expect(result.errorCount).toBe(1);
    });

    it('captures error messages in file results', async () => {
      const jobQueue = createMockJobQueue({
        failMessage: 'Specific error message',
        shouldFail: true,
      });
      const stage = createEmbeddingStage({ jobQueue });

      const result = await stage.enqueueBatch({
        files: [createSampleInput(1)],
      });

      expect(result.results[0]?.skipped).toBe(true);
      expect(result.results[0]?.skipReason).toBe('Specific error message');
    });
  });

  // =============================================================================
  // ABORT HANDLING TESTS
  // =============================================================================

  describe('abort handling', () => {
    it('respects abort signal before starting', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });
      const controller = new AbortController();
      controller.abort();

      const result = await stage.enqueueBatch({
        files: [createSampleInput(1)],
        signal: controller.signal,
      });

      expect(result.results).toHaveLength(0);
      expect(jobQueue.enqueueCalls).toHaveLength(0);
    });

    it('stops processing when aborted mid-batch', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });
      const controller = new AbortController();
      let processCount = 0;

      const result = await stage.enqueueBatch({
        files: [createSampleInput(1), createSampleInput(1), createSampleInput(1)],
        onProgress: () => {
          processCount++;
          if (processCount === 2) {
            controller.abort();
          }
        },
        signal: controller.signal,
      });

      // Should have stopped before completing all files
      expect(result.results.length).toBeLessThanOrEqual(2);
    });
  });

  // =============================================================================
  // DURATION TRACKING TESTS
  // =============================================================================

  describe('duration tracking', () => {
    it('tracks batch processing duration', async () => {
      const jobQueue = createMockJobQueue();
      const stage = createEmbeddingStage({ jobQueue });

      const result = await stage.enqueueBatch({
        files: [createSampleInput(1)],
      });

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
