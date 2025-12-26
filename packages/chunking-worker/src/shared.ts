/**
 * Shared types for chunking worker communication.
 * This module defines the message protocol between main thread and worker.
 */

/**
 * Chunking strategy determines how content is split into chunks.
 */
export type ChunkingStrategy = 'sentence' | 'token' | 'recursive';

/**
 * Type of chunk created (used for metadata).
 */
export type ChunkType = 'text' | 'sentence' | 'recursive';

/**
 * Options for chunking requests sent to the worker.
 */
export type ChunkingRequestOptions = {
  strategy: ChunkingStrategy;
  maxTokens?: number;
  overlap?: number;
  separators?: string[];
  /** When true, allows chunking beyond maxChunkableSize */
  allowLargeFiles?: boolean;
  /** When true, honor the provided strategy without applying file-type heuristics */
  forceStrategy?: boolean;
  /** If true, derive character limits from measured chars/token for this content */
  tokenTrueSizing?: boolean;
  /** Optional override for the global max token budget per chunk */
  maxTokensCap?: number;
  /** Skip file-type recommendations and only enforce global safety caps when true */
  ignoreFileTypeRecommendations?: boolean;
};

/**
 * A portable chunk that can be serialized across the worker boundary.
 * Does not include database-specific fields like fileRecordId or embeddingSetId.
 */
export type PortableChunk = {
  /** Sequential index of this chunk within the file */
  chunkIndex: number;
  /** The actual text content of the chunk */
  content: string;
  /** Hash of the content for deduplication/caching */
  contentHash: string;
  /** Token count for this chunk */
  tokenCount: number;
  /** Type of chunking that produced this chunk */
  chunkType: ChunkType;
  /** Maximum chunk size used when creating this chunk */
  chunkSize: number;
};

// ============================================================================
// Worker Message Types (Main Thread → Worker)
// ============================================================================

/**
 * Request to chunk a single file.
 */
export type ChunkRequest = {
  type: 'chunk';
  /** Unique request ID for correlation */
  id: string;
  /** File record ID (passed through for correlation, not used in chunking logic) */
  fileRecordId: string;
  /** File content to chunk */
  content: string;
  /** File name (used for strategy selection) */
  fileName: string;
  /** File path (used for strategy selection) */
  filePath: string;
  /** Chunking options */
  options: ChunkingRequestOptions;
};

/**
 * Request to chunk multiple files in a batch.
 */
export type ChunkBatchRequest = {
  type: 'chunk-batch';
  /** Array of chunk requests (without the 'type' field) */
  requests: Omit<ChunkRequest, 'type'>[];
};

/**
 * All possible messages from main thread to worker.
 */
export type WorkerRequest = ChunkRequest | ChunkBatchRequest;

// ============================================================================
// Worker Response Types (Worker → Main Thread)
// ============================================================================

/**
 * Successful chunking result for a single file.
 */
export type ChunkResult = {
  type: 'result';
  /** Request ID for correlation */
  id: string;
  /** File record ID (passed through) */
  fileRecordId: string;
  /** Array of portable chunks */
  chunks: PortableChunk[];
  /** Strategy that was actually used after file-type heuristics */
  strategyUsed: ChunkingStrategy;
  /** Total tokens across all chunks */
  totalTokens: number;
  /** True if the file was skipped (lock file, binary, etc.) */
  skipped: boolean;
  /** Reason for skipping, if applicable */
  skipReason?: string;
};

/**
 * Progress update during batch processing.
 */
export type ChunkProgress = {
  type: 'progress';
  /** Request ID for correlation */
  id: string;
  /** File record ID currently being processed */
  fileRecordId: string;
  /** Number of chunks created so far for this file */
  chunksCreated: number;
  /** For batch: current file index */
  currentIndex?: number;
  /** For batch: total files in batch */
  totalFiles?: number;
};

/**
 * Error during chunking.
 */
export type ChunkError = {
  type: 'error';
  /** Request ID for correlation */
  id: string;
  /** File record ID that failed */
  fileRecordId: string;
  /** Error message */
  error: string;
  /** Stack trace if available */
  stack?: string;
};

/**
 * Worker is ready to receive requests.
 */
export type WorkerReady = {
  type: 'ready';
};

/**
 * Log message from worker (for debugging).
 */
export type WorkerLog = {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
};

/**
 * All possible messages from worker to main thread.
 */
export type WorkerResponse = ChunkResult | ChunkProgress | ChunkError | WorkerReady | WorkerLog;
