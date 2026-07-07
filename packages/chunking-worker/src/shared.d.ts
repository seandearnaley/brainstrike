/**
 * Shared types for chunking worker communication.
 * This module defines the message protocol between main thread and worker.
 */

import type {
  ResolvedChunkingStrategy,
  ChunkingStrategy as SharedChunkingStrategy,
} from '@brainstrike/text-splitter';

/**
 * Chunking strategy determines how content is split into chunks.
 */
export type ChunkingStrategy = SharedChunkingStrategy;

/**
 * Type of chunk created (used for metadata).
 */
export type ChunkType = 'text' | 'sentence' | 'recursive';

/**
 * Options for chunking requests sent to the worker.
 */
export interface ChunkingRequestOptions {
  /** When true, allows chunking beyond maxChunkableSize */
  allowLargeFiles?: boolean;
  /** When true, honor the provided strategy without applying file-type heuristics */
  forceStrategy?: boolean;
  /** Skip file-type recommendations and only enforce global safety caps when true */
  ignoreFileTypeRecommendations?: boolean;
  maxTokens?: number;
  /** Optional override for the global max token budget per chunk */
  maxTokensCap?: number;
  overlap?: number;
  separators?: string[];
  strategy: ChunkingStrategy;
  /** If true, derive character limits from measured chars/token for this content */
  tokenTrueSizing?: boolean;
}

/**
 * A portable chunk that can be serialized across the worker boundary.
 * Does not include database-specific fields like fileRecordId or embeddingSetId.
 */
export interface PortableChunk {
  /** Sequential index of this chunk within the file */
  chunkIndex: number;
  /** Maximum chunk size used when creating this chunk */
  chunkSize: number;
  /** Type of chunking that produced this chunk */
  chunkType: ChunkType;
  /** The actual text content of the chunk */
  content: string;
  /** Hash of the content for deduplication/caching */
  contentHash: string;
  /** 1-based inclusive ending line in the original file */
  endLine: number;
  /** Exclusive ending character offset in the original file */
  endOffset: number;
  /** 1-based inclusive starting line in the original file */
  startLine: number;
  /** Inclusive starting character offset in the original file */
  startOffset: number;
  /** Token count for this chunk */
  tokenCount: number;
}

// ============================================================================
// Worker Message Types (Main Thread → Worker)
// ============================================================================

/**
 * Request to chunk a single file.
 */
export interface ChunkRequest {
  /** File content to chunk */
  content: string;
  /** File name (used for strategy selection) */
  fileName: string;
  /** File path (used for strategy selection) */
  filePath: string;
  /** File record ID (passed through for correlation, not used in chunking logic) */
  fileRecordId: string;
  /** Unique request ID for correlation */
  id: string;
  /** Chunking options */
  options: ChunkingRequestOptions;
  type: 'chunk';
}

/**
 * Request to chunk multiple files in a batch.
 */
export interface ChunkBatchRequest {
  /** Array of chunk requests (without the 'type' field) */
  requests: Omit<ChunkRequest, 'type'>[];
  type: 'chunk-batch';
}

/**
 * Request the worker to confirm it finished bootstrapping and can accept work.
 */
export interface InitRequest {
  type: 'init';
}

/**
 * All possible messages from main thread to worker.
 */
export type WorkerRequest = ChunkRequest | ChunkBatchRequest | InitRequest;

// ============================================================================
// Worker Response Types (Worker → Main Thread)
// ============================================================================

/**
 * Successful chunking result for a single file.
 */
export interface ChunkResult {
  /** Array of portable chunks */
  chunks: PortableChunk[];
  /** File record ID (passed through) */
  fileRecordId: string;
  /** Request ID for correlation */
  id: string;
  /** True if the file was skipped (lock file, binary, etc.) */
  skipped: boolean;
  /** Reason for skipping, if applicable */
  skipReason?: string;
  /** Number of candidate chunks dropped because source line/offset ranges could not be resolved */
  sourceRangeSkippedChunks?: number;
  /** Strategy that was actually used after file-type heuristics */
  strategyUsed: ResolvedChunkingStrategy;
  /** Total tokens across all chunks */
  totalTokens: number;
  type: 'result';
}

/**
 * Progress update during batch processing.
 */
export interface ChunkProgress {
  /** Number of chunks created so far for this file */
  chunksCreated: number;
  /** For batch: current file index */
  currentIndex?: number;
  /** File record ID currently being processed */
  fileRecordId: string;
  /** Request ID for correlation */
  id: string;
  /** For batch: total files in batch */
  totalFiles?: number;
  type: 'progress';
}

/**
 * Error during chunking.
 */
export interface ChunkError {
  /** Error message */
  error: string;
  /** File record ID that failed */
  fileRecordId: string;
  /** Request ID for correlation */
  id: string;
  /** Stack trace if available */
  stack?: string;
  type: 'error';
}

/**
 * Worker is ready to receive requests.
 */
export interface WorkerReady {
  type: 'ready';
}

/**
 * Log message from worker (for debugging).
 */
export interface WorkerLog {
  data?: Record<string, unknown>;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  type: 'log';
}

/**
 * All possible messages from worker to main thread.
 */
export type WorkerResponse = ChunkResult | ChunkProgress | ChunkError | WorkerReady | WorkerLog;
