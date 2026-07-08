/**
 * @module pipeline/chunking-stage
 *
 * Chunking stage orchestrator for the indexing pipeline.
 *
 * This module provides the chunking layer between file import and embedding:
 * - Takes imported file content
 * - Chunks using the Web Worker (off main thread)
 * - Returns canonical ChunkingOutput for the embedding stage
 *
 * ## Design Principles
 *
 * 1. **Worker-Only**: All chunking happens off-thread via ChunkingWorkerPort
 * 2. **Pure Orchestration**: No database writes - just transforms content to chunks
 * 3. **Error Isolation**: Individual file failures don't halt batch processing
 * 4. **Progress Tracking**: Real-time progress with configurable callbacks
 *
 * @example
 * ```typescript
 * const stage = createChunkingStage({
 *   workerPort,
 *   defaultStrategy: 'recursive',
 * });
 *
 * const output = await stage.chunkFile({
 *   fileId: generateFileId(),
 *   content: 'function hello() { return "world"; }',
 *   fileName: 'hello.ts',
 *   filePath: '/src/hello.ts',
 *   strategy: 'recursive',
 * });
 * ```
 */

import { resolveChunkingStrategyForFile } from '@brainstrike/text-splitter';
import type {
  ChunkingInput,
  ChunkingOutput,
  ChunkingStrategy,
  ChunkOutput,
  ContentHash,
  FileId,
  ResolvedChunkingStrategy,
} from './types.js';

// =============================================================================
// WORKER PORT INTERFACE
// =============================================================================

/**
 * Portable chunk from the chunking worker.
 * This mirrors @brainstrike/chunking-worker's PortableChunk type.
 */
export interface PortableChunk {
  chunkIndex: number;
  chunkSize: number;
  chunkType: 'text' | 'code' | 'sentence' | 'recursive';
  content: string;
  contentHash: string;
  endLine: number;
  endOffset: number;
  startLine: number;
  startOffset: number;
  tokenCount: number;
}

/**
 * Result from chunking a single file via the worker.
 * This mirrors @brainstrike/chunking-worker's ChunkResult type.
 */
export interface WorkerChunkResult {
  chunks: PortableChunk[];
  fileRecordId: string;
  id: string;
  skipped: boolean;
  skipReason?: string;
  strategyUsed: ResolvedChunkingStrategy;
  totalTokens: number;
  type: 'result';
}

/**
 * Options passed to the chunking worker.
 */
export interface ChunkingRequestOptions {
  forceStrategy?: boolean;
  ignoreFileTypeRecommendations?: boolean;
  maxTokens?: number;
  overlap?: number;
  strategy: ChunkingStrategy;
}

/**
 * Abstract interface for the chunking worker port.
 *
 * This allows the pipeline to work with any worker port implementation
 * that conforms to this interface, enabling testing and flexibility.
 */
export interface ChunkingWorkerPortLike {
  /**
   * Chunk multiple files in a batch.
   */
  chunkBatch?: (
    files: Array<{
      fileRecordId: string;
      content: string;
      fileName: string;
      filePath: string;
    }>,
    options: ChunkingRequestOptions,
    callbacks?: {
      onProgress?: (
        fileRecordId: string,
        chunksCreated: number,
        currentIndex: number,
        total: number
      ) => void;
      onFileComplete?: (fileRecordId: string, result: WorkerChunkResult) => void;
      onFileError?: (fileRecordId: string, error: string) => void;
    }
  ) => Promise<WorkerChunkResult[]>;
  /**
   * Chunk a single file.
   */
  chunkFile: (
    fileRecordId: string,
    content: string,
    fileName: string,
    filePath: string,
    options: ChunkingRequestOptions
  ) => Promise<WorkerChunkResult>;

  /**
   * Check if the worker is ready.
   */
  isReady: () => boolean;

  /**
   * Terminate the worker.
   */
  terminate: () => void;
}

// =============================================================================
// CHUNKING STAGE TYPES
// =============================================================================

/**
 * Configuration for creating a chunking stage.
 */
export interface ChunkingStageConfig {
  /** Maximum tokens per chunk */
  defaultMaxTokens?: number;
  /** Token overlap between chunks */
  defaultOverlap?: number;
  /** Default chunking strategy if not specified per-file */
  defaultStrategy?: ChunkingStrategy;
  /** Worker port for off-thread chunking */
  workerPort: ChunkingWorkerPortLike;
  /** Timeout for worker readiness (ms) */
  workerReadyTimeoutMs?: number;
}

/**
 * Progress callback for chunking operations.
 */
export type ChunkingProgressCallback = (progress: ChunkingStageProgress) => void;

/**
 * Progress state during chunking.
 */
export interface ChunkingStageProgress {
  /** Files completed (success or failure) */
  completedFiles: number;
  /** Current file being chunked */
  currentFile?: string;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** Files that failed */
  failedFiles: number;
  /** Total chunks created so far */
  totalChunks: number;
  /** Total files to chunk */
  totalFiles: number;
}

/**
 * Input for batch chunking.
 */
export interface ChunkingBatchInput {
  /** Continue processing on individual file errors */
  continueOnError?: boolean;
  /** Files to chunk */
  files: ChunkingInput[];
  /** Progress callback */
  onProgress?: ChunkingProgressCallback;
  /** Abort signal */
  signal?: AbortSignal;
}

/**
 * Result from batch chunking.
 */
export interface ChunkingBatchResult {
  /** Processing duration in ms */
  durationMs: number;
  /** Failed chunking operations */
  errorCount: number;
  /** Results for each file */
  results: ChunkingOutput[];
  /** Successful chunking operations */
  successCount: number;
  /** Total chunks created */
  totalChunks: number;
  /** Total files processed */
  totalFiles: number;
  /** Total tokens across all chunks */
  totalTokens: number;
}

/**
 * The chunking stage interface.
 */
export interface ChunkingStage {
  /**
   * Chunk multiple files.
   */
  chunkBatch: (input: ChunkingBatchInput) => Promise<ChunkingBatchResult>;
  /**
   * Chunk a single file.
   */
  chunkFile: (input: ChunkingInput) => Promise<ChunkingOutput>;

  /**
   * Check if the worker is ready.
   */
  isReady: () => boolean;

  /**
   * Terminate the worker.
   */
  terminate: () => void;

  /**
   * Wait for the worker to become ready.
   */
  waitForReady: (timeoutMs?: number) => Promise<boolean>;
}

// =============================================================================
// CONVERSION UTILITIES
// =============================================================================

/**
 * Convert a portable chunk to the pipeline's canonical ChunkOutput.
 */
function toChunkOutput(portable: PortableChunk): ChunkOutput {
  return {
    chunkIndex: portable.chunkIndex,
    chunkSize: portable.chunkSize,
    chunkType: portable.chunkType,
    content: portable.content,
    contentHash: portable.contentHash as ContentHash,
    endLine: portable.endLine,
    endOffset: portable.endOffset,
    startLine: portable.startLine,
    startOffset: portable.startOffset,
    tokenCount: portable.tokenCount,
  };
}

/**
 * Convert worker result to pipeline's canonical ChunkingOutput.
 */
function toChunkingOutput(fileId: FileId, result: WorkerChunkResult): ChunkingOutput {
  const output: ChunkingOutput = {
    chunks: result.chunks.map(toChunkOutput),
    fileId,
    skipped: result.skipped,
    strategyUsed: result.strategyUsed,
    totalTokens: result.totalTokens,
  };

  // Conditionally add skipReason (exactOptionalPropertyTypes compliance)
  if (result.skipReason !== undefined) {
    output.skipReason = result.skipReason;
  }

  return output;
}

/**
 * Build a failed chunking output.
 */
function buildFailedOutput(fileId: FileId, error: string): ChunkingOutput {
  return {
    chunks: [],
    fileId,
    skipped: true,
    skipReason: error,
    strategyUsed: 'sentence',
    totalTokens: 0,
  };
}

// =============================================================================
// CHUNKING STAGE FACTORY
// =============================================================================

const DEFAULT_WORKER_READY_TIMEOUT_MS = 5000;
const READY_POLL_INTERVAL_MS = 100;

/**
 * Create a chunking stage instance.
 *
 * @param config - Stage configuration
 * @returns A configured chunking stage
 */
export function createChunkingStage(config: ChunkingStageConfig): ChunkingStage {
  const {
    workerPort,
    defaultStrategy = 'sentence',
    defaultMaxTokens,
    defaultOverlap,
    workerReadyTimeoutMs = DEFAULT_WORKER_READY_TIMEOUT_MS,
  } = config;

  /**
   * Wait for the worker to become ready.
   */
  async function waitForReady(timeoutMs: number = workerReadyTimeoutMs): Promise<boolean> {
    if (workerPort.isReady()) {
      return true;
    }

    const startTime = Date.now();
    while (!workerPort.isReady() && Date.now() - startTime < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
    }

    return workerPort.isReady();
  }

  /**
   * Build worker options from chunking input.
   */
  function buildWorkerOptions(input: ChunkingInput): ChunkingRequestOptions {
    const options: ChunkingRequestOptions = {
      strategy: input.strategy ?? defaultStrategy,
    };

    const maxTokens = input.maxTokens ?? defaultMaxTokens;
    if (maxTokens !== undefined) {
      options.maxTokens = maxTokens;
    }

    const overlap = input.overlap ?? defaultOverlap;
    if (overlap !== undefined) {
      options.overlap = overlap;
    }

    return options;
  }

  /**
   * Chunk a single file.
   */
  async function chunkFile(input: ChunkingInput): Promise<ChunkingOutput> {
    // Ensure worker is ready
    const ready = await waitForReady();
    if (!ready) {
      return buildFailedOutput(input.fileId, 'Chunking worker failed to become ready');
    }

    try {
      const options = buildWorkerOptions(input);
      const result = await workerPort.chunkFile(
        input.fileId,
        input.content,
        input.fileName,
        input.filePath,
        options
      );

      return toChunkingOutput(input.fileId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildFailedOutput(input.fileId, message);
    }
  }

  // ---------------------------------------------------------------------------
  // Batch Processing Helpers (extracted to reduce cognitive complexity)
  // ---------------------------------------------------------------------------

  interface BatchState {
    failedCount: number;
    results: ChunkingOutput[];
    totalChunks: number;
    totalTokens: number;
  }

  function createBatchState(): BatchState {
    return {
      failedCount: 0,
      results: [],
      totalChunks: 0,
      totalTokens: 0,
    };
  }

  async function processOneBatchFile(
    file: ChunkingInput,
    state: BatchState,
    continueOnError: boolean
  ): Promise<boolean> {
    const output = await chunkFile(file);
    state.results.push(output);

    if (output.skipped) {
      state.failedCount++;
      return !continueOnError; // Return true to stop if not continuing on error
    }

    state.totalChunks += output.chunks.length;
    state.totalTokens += output.totalTokens;
    return false; // Continue processing
  }

  function emitBatchProgress(
    onProgress: ChunkingProgressCallback | undefined,
    totalFiles: number,
    completedFiles: number,
    state: BatchState,
    currentFile: string | undefined,
    startTime: number
  ): void {
    if (!onProgress) {
      return;
    }

    const progress: ChunkingStageProgress = {
      completedFiles,
      elapsedMs: Date.now() - startTime,
      failedFiles: state.failedCount,
      totalChunks: state.totalChunks,
      totalFiles,
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
  ): ChunkingBatchResult {
    return {
      durationMs: Date.now() - startTime,
      errorCount: state.failedCount,
      results: state.results,
      successCount: state.results.length - state.failedCount,
      totalChunks: state.totalChunks,
      totalFiles,
      totalTokens: state.totalTokens,
    };
  }

  /**
   * Chunk multiple files.
   */
  async function chunkBatch(batchInput: ChunkingBatchInput): Promise<ChunkingBatchResult> {
    const { files, onProgress, signal, continueOnError = true } = batchInput;
    const startTime = Date.now();

    // Early abort check
    if (signal?.aborted) {
      return buildEmptyBatchResult(files.length, startTime);
    }

    // Ensure worker is ready
    const ready = await waitForReady();
    if (!ready) {
      return buildFailedBatchResult(files, 'Chunking worker failed to become ready', startTime);
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

      emitBatchProgress(onProgress, files.length, i, state, file.fileName, startTime);

      const shouldStop = await processOneBatchFile(file, state, continueOnError);
      if (shouldStop) {
        break;
      }
    }

    emitBatchProgress(onProgress, files.length, state.results.length, state, undefined, startTime);

    return buildBatchResult(files.length, state, startTime);
  }

  return {
    chunkBatch,
    chunkFile,
    isReady: () => workerPort.isReady(),
    terminate: () => workerPort.terminate(),
    waitForReady,
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Build an empty batch result for aborted operations.
 */
function buildEmptyBatchResult(totalFiles: number, startTime: number): ChunkingBatchResult {
  return {
    durationMs: Date.now() - startTime,
    errorCount: 0,
    results: [],
    successCount: 0,
    totalChunks: 0,
    totalFiles,
    totalTokens: 0,
  };
}

/**
 * Build a failed batch result when worker is not ready.
 */
function buildFailedBatchResult(
  files: ChunkingInput[],
  error: string,
  startTime: number
): ChunkingBatchResult {
  const results = files.map((file) => buildFailedOutput(file.fileId, error));
  return {
    durationMs: Date.now() - startTime,
    errorCount: files.length,
    results,
    successCount: 0,
    totalChunks: 0,
    totalFiles: files.length,
    totalTokens: 0,
  };
}

// =============================================================================
// STRATEGY UTILITIES
// =============================================================================

/**
 * Common code file extensions that benefit from recursive chunking.
 */
export function getRecommendedStrategy(
  filePath: string,
  defaultStrategy: ChunkingStrategy = 'auto'
): ChunkingStrategy {
  return resolveChunkingStrategyForFile(filePath, defaultStrategy);
}
