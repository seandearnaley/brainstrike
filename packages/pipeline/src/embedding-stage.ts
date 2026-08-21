/**
 * @module pipeline/embedding-stage
 *
 * Embedding stage orchestrator for the indexing pipeline.
 *
 * This module provides the embedding job enqueue layer between chunking and embedding execution:
 * - Takes chunking output (file chunks)
 * - Generates chunk IDs and builds job payloads
 * - Enqueues embedding jobs to the durable DB JobQueue
 * - Returns canonical EmbeddingEnqueueOutput for tracking
 *
 * ## Design Principles
 *
 * 1. **Queue-Only**: All enqueuing happens via JobQueueLike interface (no direct DB writes)
 * 2. **Pure Orchestration**: No embedding execution - just job creation
 * 3. **Idempotent**: Dedupe keys ensure same chunk+set+content combination is only enqueued once.
 *    Note this stage's key does NOT include the model: while a job for a chunk+set is queued or
 *    running, re-enqueuing it under a different model dedupes into the existing job rather than
 *    creating a new one. See `buildEmbedJobDedupeKey` in `@brainstrike/indexing-contract`.
 * 4. **Progress Tracking**: Real-time progress with configurable callbacks
 *
 * @example
 * ```typescript
 * const stage = createEmbeddingStage({
 *   jobQueue,
 *   queueName: 'embeddings',
 *   defaultModelKey: 'openai::text-embedding-3-small',
 * });
 *
 * const output = await stage.enqueueChunks({
 *   fileId: '550e8400-e29b-41d4-a716-446655440000',
 *   embeddingSetId: '550e8400-e29b-41d4-a716-446655440001',
 *   chunks: [
 *     { chunkIndex: 0, content: 'Hello world', contentHash: 'abc123...', tokenCount: 2 },
 *   ],
 * });
 * ```
 */

import {
  buildEmbeddingJobInputHashes,
  buildEmbedJobDedupeKey,
} from '@brainstrike/indexing-contract';
import { generateChunkId } from './identifiers.js';
import type { ChunkId, ChunkOutput, EmbeddingSetId, FileId, JobId, JobState } from './types.js';

// =============================================================================
// JOB QUEUE INTERFACE
// =============================================================================

/**
 * Minimal job returned from enqueue operations.
 * This mirrors the essential fields from @brainstrike/db JobQueue.
 */
export interface EnqueuedJob {
  dedupeKey: string | null;
  id: JobId;
  jobType: 'embed_chunk';
  queue: string;
  state: JobState;
}

/**
 * Parameters for enqueuing a single job.
 */
export interface EnqueueJobParams {
  dedupeKey?: string;
  jobType: 'embed_chunk';
  payload: unknown;
  queue: string;
}

/**
 * Abstract interface for the job queue.
 *
 * This allows the pipeline to work with any job queue implementation
 * that conforms to this interface, enabling testing and flexibility.
 */
export interface JobQueueLike {
  /**
   * Enqueue a single job.
   * Should be idempotent based on dedupeKey.
   */
  enqueue: (params: EnqueueJobParams) => Promise<EnqueuedJob>;

  /**
   * Optional batch enqueue for better performance.
   * If not provided, falls back to individual enqueue calls.
   */
  enqueueBatch?: (params: EnqueueJobParams[]) => Promise<EnqueuedJob[]>;
}

// =============================================================================
// EMBEDDING STAGE TYPES
// =============================================================================

/**
 * Configuration for creating an embedding stage.
 */
export interface EmbeddingStageConfig {
  /** Default model key if not specified per-request */
  defaultModelKey?: string;
  /** Expected embedding dimension (for validation/metadata) */
  expectedDimension?: number;
  /** Job queue for enqueuing embedding jobs */
  jobQueue: JobQueueLike;
  /** Queue name for embedding jobs */
  queueName?: string;
}

/**
 * Input for enqueuing chunks from a single file.
 */
export interface EnqueueChunksInput {
  /** Pre-generated chunk IDs (if chunks are already persisted) */
  chunkIds?: ChunkId[];
  /** Chunks to enqueue (from chunking stage output) */
  chunks: ChunkOutput[];
  /** Target embedding set */
  embeddingSetId: EmbeddingSetId;
  /** Expected embedding dimension */
  expectedDimension?: number;
  /** Source file record ID */
  fileId: FileId;
  /** Model key for embedding generation */
  modelKey?: string;
}

/**
 * Output from enqueuing chunks.
 */
export interface EnqueueChunksOutput {
  /** Generated chunk IDs (in same order as input chunks) */
  chunkIds: ChunkId[];
  /** Source file record ID */
  fileId: FileId;
  /** Job IDs for enqueued jobs */
  jobIds: JobId[];
  /** Number of jobs that were deduplicated (already existed) */
  jobsDeduped: number;
  /** Number of jobs enqueued */
  jobsEnqueued: number;
  /** Whether any chunks were skipped */
  skipped: boolean;
  /** Reason for skipping, if applicable */
  skipReason?: string;
}

/**
 * Progress callback for embedding enqueue operations.
 */
export type EmbeddingEnqueueProgressCallback = (progress: EmbeddingEnqueueProgress) => void;

/**
 * Progress state during embedding enqueue.
 */
export interface EmbeddingEnqueueProgress {
  /** Files completed (success or failure) */
  completedFiles: number;
  /** Current file being processed */
  currentFile?: string;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** Files that failed */
  failedFiles: number;
  /** Total files to process */
  totalFiles: number;
  /** Total jobs deduplicated so far */
  totalJobsDeduped: number;
  /** Total jobs enqueued so far */
  totalJobsEnqueued: number;
}

/**
 * Input for batch embedding enqueue.
 */
export interface EmbeddingBatchInput {
  /** Continue processing on individual file errors */
  continueOnError?: boolean;
  /** Files with their chunks to enqueue */
  files: EnqueueChunksInput[];
  /** Progress callback */
  onProgress?: EmbeddingEnqueueProgressCallback;
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * Result from batch embedding enqueue.
 */
export interface EmbeddingBatchResult {
  /** Processing duration in ms */
  durationMs: number;
  /** Failed enqueue operations */
  errorCount: number;
  /** Results for each file */
  results: EnqueueChunksOutput[];
  /** Successful enqueue operations */
  successCount: number;
  /** Total files processed */
  totalFiles: number;
  /** Total jobs deduplicated */
  totalJobsDeduped: number;
  /** Total jobs enqueued */
  totalJobsEnqueued: number;
}

/**
 * The embedding stage interface.
 */
export interface EmbeddingStage {
  /**
   * Enqueue embedding jobs for chunks from multiple files.
   */
  enqueueBatch: (input: EmbeddingBatchInput) => Promise<EmbeddingBatchResult>;
  /**
   * Enqueue embedding jobs for chunks from a single file.
   */
  enqueueChunks: (input: EnqueueChunksInput) => Promise<EnqueueChunksOutput>;
}

// =============================================================================
// JOB PAYLOAD TYPE
// =============================================================================

/**
 * Embedding job payload for the queue.
 * Contains all data needed to embed a chunk independently.
 */
interface EmbedJobPayloadInternal {
  chunkId: string;
  chunkIndex: number;
  contentHash: string;
  embeddingInputHash: string;
  embeddingSetId: string;
  expectedDimension: number;
  fileRecordId: string;
  modelKey: string;
  sourceContentHash: string;
}

// =============================================================================
// EMBEDDING STAGE FACTORY
// =============================================================================

const DEFAULT_QUEUE_NAME = 'embeddings';
const DEFAULT_MODEL_KEY = 'local::all-MiniLM-L6-v2';
const DEFAULT_DIMENSION = 384;

/**
 * Create an embedding stage instance.
 *
 * @param config - Stage configuration
 * @returns A configured embedding stage
 */
export function createEmbeddingStage(config: EmbeddingStageConfig): EmbeddingStage {
  const {
    jobQueue,
    queueName = DEFAULT_QUEUE_NAME,
    defaultModelKey = DEFAULT_MODEL_KEY,
    expectedDimension: defaultDimension = DEFAULT_DIMENSION,
  } = config;

  /**
   * Build job payload for a single chunk.
   */
  function buildJobPayload(
    chunkId: ChunkId,
    chunk: ChunkOutput,
    fileId: FileId,
    embeddingSetId: EmbeddingSetId,
    modelKey: string,
    expectedDimension: number,
    embeddingInputHash: string
  ): EmbedJobPayloadInternal {
    return {
      chunkId,
      chunkIndex: chunk.chunkIndex,
      contentHash: chunk.contentHash,
      embeddingInputHash,
      embeddingSetId,
      expectedDimension,
      fileRecordId: fileId,
      modelKey,
      sourceContentHash: chunk.contentHash,
    };
  }

  // ---------------------------------------------------------------------------
  // Single File Enqueue Helpers
  // ---------------------------------------------------------------------------

  /**
   * Build empty output for files with no chunks.
   */
  function buildEmptyChunksOutput(fileId: FileId): EnqueueChunksOutput {
    return {
      chunkIds: [],
      fileId,
      jobIds: [],
      jobsDeduped: 0,
      jobsEnqueued: 0,
      skipped: true,
      skipReason: 'No chunks to enqueue',
    };
  }

  /**
   * Resolve chunk IDs - use provided or generate new ones.
   */
  function resolveChunkIds(chunks: ChunkOutput[], providedChunkIds?: ChunkId[]): ChunkId[] {
    if (providedChunkIds && providedChunkIds.length === chunks.length) {
      return providedChunkIds;
    }
    return chunks.map(() => generateChunkId());
  }

  /**
   * Build enqueue params for all chunks.
   */
  async function buildEnqueueParams(
    chunks: ChunkOutput[],
    chunkIds: ChunkId[],
    fileId: FileId,
    embeddingSetId: EmbeddingSetId,
    modelKey: string,
    expectedDimension: number
  ): Promise<EnqueueJobParams[]> {
    const embeddingInputHashes = await buildEmbeddingJobInputHashes(
      chunks.map(({ contentHash }) => contentHash),
      modelKey
    );
    const params: EnqueueJobParams[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkId = chunkIds[i];
      if (!(chunk && chunkId)) {
        continue;
      }
      const embeddingInputHash = embeddingInputHashes[i];
      if (!embeddingInputHash) {
        throw new Error(`Missing embedding input hash for chunk '${chunkId}'.`);
      }

      const payload = buildJobPayload(
        chunkId,
        chunk,
        fileId,
        embeddingSetId,
        modelKey,
        expectedDimension,
        embeddingInputHash
      );
      const dedupeKey = buildEmbedJobDedupeKey(chunkId, embeddingSetId, chunk.contentHash);

      params.push({
        dedupeKey,
        jobType: 'embed_chunk',
        payload,
        queue: queueName,
      });
    }
    return params;
  }

  /**
   * Build successful enqueue output from enqueued jobs.
   */
  function buildEnqueueOutput(
    fileId: FileId,
    chunkIds: ChunkId[],
    enqueuedJobs: EnqueuedJob[],
    totalChunks: number
  ): EnqueueChunksOutput {
    const jobIds = enqueuedJobs.map((job) => job.id);
    const dedupedCount = Math.max(0, totalChunks - enqueuedJobs.length);

    return {
      chunkIds,
      fileId,
      jobIds,
      jobsDeduped: dedupedCount,
      jobsEnqueued: enqueuedJobs.length,
      skipped: false,
    };
  }

  /**
   * Enqueue embedding jobs for chunks from a single file.
   */
  async function enqueueChunks(input: EnqueueChunksInput): Promise<EnqueueChunksOutput> {
    const { fileId, embeddingSetId, chunks, chunkIds: providedChunkIds } = input;
    const modelKey = input.modelKey ?? defaultModelKey;
    const expectedDimension = input.expectedDimension ?? defaultDimension;

    if (chunks.length === 0) {
      return buildEmptyChunksOutput(fileId);
    }

    const chunkIds = resolveChunkIds(chunks, providedChunkIds);
    const enqueueParams = await buildEnqueueParams(
      chunks,
      chunkIds,
      fileId,
      embeddingSetId,
      modelKey,
      expectedDimension
    );
    const enqueuedJobs = await enqueueJobsBatch(jobQueue, enqueueParams);

    return buildEnqueueOutput(fileId, chunkIds, enqueuedJobs, chunks.length);
  }

  /**
   * Enqueue embedding jobs for chunks from multiple files.
   */
  async function enqueueBatch(batchInput: EmbeddingBatchInput): Promise<EmbeddingBatchResult> {
    const { files, onProgress, signal, continueOnError = true } = batchInput;
    const startTime = Date.now();

    // Early abort check
    if (signal?.aborted) {
      return buildEmptyBatchResult(files.length, startTime);
    }

    const state = createBatchState();

    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) {
        break;
      }

      const file = files[i];
      if (!file) {
        continue;
      }

      emitBatchProgress(onProgress, files.length, i, state, file.fileId, startTime);

      const shouldStop = await processOneFile(file, state, continueOnError);
      if (shouldStop) {
        break;
      }
    }

    emitBatchProgress(onProgress, files.length, state.results.length, state, undefined, startTime);

    return buildBatchResult(files.length, state, startTime);
  }

  // ---------------------------------------------------------------------------
  // Batch Processing Helpers
  // ---------------------------------------------------------------------------

  interface BatchState {
    failedCount: number;
    results: EnqueueChunksOutput[];
    totalJobsDeduped: number;
    totalJobsEnqueued: number;
  }

  function createBatchState(): BatchState {
    return {
      failedCount: 0,
      results: [],
      totalJobsDeduped: 0,
      totalJobsEnqueued: 0,
    };
  }

  async function processOneFile(
    file: EnqueueChunksInput,
    state: BatchState,
    continueOnError: boolean
  ): Promise<boolean> {
    try {
      const output = await enqueueChunks(file);
      state.results.push(output);

      if (output.skipped && output.skipReason && output.skipReason !== 'No chunks to enqueue') {
        state.failedCount++;
        return !continueOnError;
      }

      state.totalJobsEnqueued += output.jobsEnqueued;
      state.totalJobsDeduped += output.jobsDeduped;
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.results.push(buildFailedOutput(file.fileId, message));
      state.failedCount++;
      return !continueOnError;
    }
  }

  function emitBatchProgress(
    onProgress: EmbeddingEnqueueProgressCallback | undefined,
    totalFiles: number,
    completedFiles: number,
    state: BatchState,
    currentFile: FileId | undefined,
    startTime: number
  ): void {
    if (!onProgress) {
      return;
    }

    const progress: EmbeddingEnqueueProgress = {
      completedFiles,
      elapsedMs: Date.now() - startTime,
      failedFiles: state.failedCount,
      totalFiles,
      totalJobsDeduped: state.totalJobsDeduped,
      totalJobsEnqueued: state.totalJobsEnqueued,
    };

    if (currentFile !== undefined) {
      progress.currentFile = currentFile;
    }

    onProgress(progress);
  }

  function buildBatchResult(
    totalFiles: number,
    state: BatchState,
    startTime: number
  ): EmbeddingBatchResult {
    return {
      durationMs: Date.now() - startTime,
      errorCount: state.failedCount,
      results: state.results,
      successCount: state.results.length - state.failedCount,
      totalFiles,
      totalJobsDeduped: state.totalJobsDeduped,
      totalJobsEnqueued: state.totalJobsEnqueued,
    };
  }

  return {
    enqueueBatch,
    enqueueChunks,
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Enqueue jobs using batch method if available, otherwise individually.
 */
async function enqueueJobsBatch(
  jobQueue: JobQueueLike,
  params: EnqueueJobParams[]
): Promise<EnqueuedJob[]> {
  if (params.length === 0) {
    return [];
  }

  // Use batch method if available
  if (jobQueue.enqueueBatch) {
    return jobQueue.enqueueBatch(params);
  }

  // Fallback to individual enqueue
  const results: EnqueuedJob[] = [];
  for (const param of params) {
    const job = await jobQueue.enqueue(param);
    results.push(job);
  }
  return results;
}

/**
 * Build a failed enqueue output.
 */
function buildFailedOutput(fileId: FileId, error: string): EnqueueChunksOutput {
  return {
    chunkIds: [],
    fileId,
    jobIds: [],
    jobsDeduped: 0,
    jobsEnqueued: 0,
    skipped: true,
    skipReason: error,
  };
}

/**
 * Build an empty batch result for aborted operations.
 */
function buildEmptyBatchResult(totalFiles: number, startTime: number): EmbeddingBatchResult {
  return {
    durationMs: Date.now() - startTime,
    errorCount: 0,
    results: [],
    successCount: 0,
    totalFiles,
    totalJobsDeduped: 0,
    totalJobsEnqueued: 0,
  };
}
