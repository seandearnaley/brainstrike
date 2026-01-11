/**
 * @module pipeline/types
 *
 * Canonical data model for the indexing pipeline (File → Chunk → Embed → Vector).
 *
 * This module defines the authoritative types and identifiers used throughout the
 * pipeline stages. All orchestration code should use these types to ensure consistency.
 *
 * ## Identity Model
 *
 * | Entity        | Primary Key | Dedupe Key                           |
 * |---------------|-------------|--------------------------------------|
 * | FileRecord    | UUID        | contentHash + embeddingSetId         |
 * | FileChunk     | UUID        | fileRecordId + chunkIndex            |
 * | EmbeddingJob  | UUID        | chunkId + embeddingSetId + modelKey  |
 *
 * ## Stage Flow
 *
 * ```
 * FileImport → FileRecord → Chunking → FileChunk[] → EmbedJob → Embedding
 *     │             │           │            │            │
 *   Stage 1      Store       Stage 2      Store       Stage 3
 * ```
 */

// =============================================================================
// BRANDED ID TYPES
// =============================================================================

/**
 * Branded type for file record UUIDs.
 * Provides compile-time type safety to prevent mixing different ID types.
 */
export type FileId = string & { readonly __brand: 'FileId' };

/**
 * Branded type for file chunk UUIDs.
 */
export type ChunkId = string & { readonly __brand: 'ChunkId' };

/**
 * Branded type for embedding set UUIDs.
 */
export type EmbeddingSetId = string & { readonly __brand: 'EmbeddingSetId' };

/**
 * Branded type for embedding job UUIDs.
 */
export type JobId = string & { readonly __brand: 'JobId' };

/**
 * SHA-256 content hash for deduplication.
 */
export type ContentHash = string & { readonly __brand: 'ContentHash' };

// =============================================================================
// STAGE DATA TYPES
// =============================================================================

/**
 * Input to the import stage - raw file data from filesystem.
 */
export interface FileImportInput {
  /** Absolute file path */
  path: string;
  /** File name (basename) */
  name: string;
  /** Raw file content as string */
  content: string;
  /** File size in bytes */
  size: number;
  /** Target embedding set for this file */
  embeddingSetId?: EmbeddingSetId;
}

/**
 * Output from import stage - stored file record reference.
 */
export interface FileImportOutput {
  /** Assigned file record ID */
  fileId: FileId;
  /** Content hash used for deduplication */
  contentHash: ContentHash;
  /** Whether this was a new import or existing file */
  isNew: boolean;
  /** Token count from import */
  tokenCount: number;
}

/**
 * Chunking strategy determines how content is split.
 */
export type ChunkingStrategy = 'sentence' | 'token' | 'recursive';

/**
 * Input to the chunking stage.
 */
export interface ChunkingInput {
  /** File record ID to chunk */
  fileId: FileId;
  /** File content to chunk */
  content: string;
  /** File name for strategy hints */
  fileName: string;
  /** File path for strategy hints */
  filePath: string;
  /** Chunking strategy to use */
  strategy: ChunkingStrategy;
  /** Maximum tokens per chunk */
  maxTokens?: number;
  /** Overlap between chunks */
  overlap?: number;
}

/**
 * Single chunk output from chunking stage.
 */
export interface ChunkOutput {
  /** Sequential index within the file (0-based) */
  chunkIndex: number;
  /** Chunk text content */
  content: string;
  /** SHA-256 hash of content */
  contentHash: ContentHash;
  /** Token count for this chunk */
  tokenCount: number;
  /** Chunk type classification */
  chunkType: 'text' | 'code' | 'sentence' | 'recursive';
  /** Maximum chunk size used */
  chunkSize: number;
}

/**
 * Output from chunking stage.
 */
export interface ChunkingOutput {
  /** Source file record ID */
  fileId: FileId;
  /** Created chunks */
  chunks: ChunkOutput[];
  /** Strategy actually used (may differ from requested) */
  strategyUsed: ChunkingStrategy;
  /** Total tokens across all chunks */
  totalTokens: number;
  /** Whether file was skipped (binary, lock file, etc.) */
  skipped: boolean;
  /** Reason for skipping, if applicable */
  skipReason?: string;
}

/**
 * Input to the embedding stage - a chunk ready for embedding.
 */
export interface EmbeddingInput {
  /** Chunk ID to embed */
  chunkId: ChunkId;
  /** Content to embed */
  content: string;
  /** Content hash for caching */
  contentHash: ContentHash;
  /** Target embedding set */
  embeddingSetId: EmbeddingSetId;
  /** Model key for embedding generation */
  modelKey: string;
}

/**
 * Output from embedding stage.
 */
export interface EmbeddingOutput {
  /** Chunk ID that was embedded */
  chunkId: ChunkId;
  /** Generated embedding vector */
  embedding: number[];
  /** Model key used */
  modelKey: string;
  /** Hash of the embedding for cache invalidation */
  embeddingHash: ContentHash;
}

// =============================================================================
// JOB QUEUE TYPES
// =============================================================================

/**
 * Embedding job payload for durable queue.
 * Contains all data needed to embed a chunk independently.
 */
export interface EmbedJobPayload {
  /** Chunk ID to embed */
  chunkId: ChunkId;
  /** Embedding set this job belongs to */
  embeddingSetId: EmbeddingSetId;
  /** Model key for embedding */
  modelKey: string;
  /** Content hash for caching/dedupe */
  contentHash: ContentHash;
  /** Original file ID for tracking */
  fileId: FileId;
  /** Chunk index for ordering */
  chunkIndex: number;
}

/**
 * Job states in the queue.
 */
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired';

// =============================================================================
// PROGRESS TYPES
// =============================================================================

/**
 * Progress for a single stage.
 */
export interface StageProgress {
  /** Total items to process */
  total: number;
  /** Items completed (success or skip) */
  completed: number;
  /** Items currently in progress */
  inProgress: number;
  /** Items that failed */
  failed: number;
  /** Current item being processed */
  currentItem?: string;
}

/**
 * Aggregated progress across all pipeline stages.
 */
export interface PipelineProgress {
  /** Current pipeline phase */
  phase: 'importing' | 'chunking' | 'embedding' | 'complete' | 'error';
  /** Import stage progress */
  import: StageProgress;
  /** Chunking stage progress */
  chunking: StageProgress;
  /** Embedding stage progress */
  embedding: StageProgress;
  /** Overall start time */
  startedAt: string;
  /** Overall end time (if complete) */
  completedAt?: string;
  /** Recent errors for diagnostics */
  recentErrors: Array<{ stage: string; item: string; error: string; timestamp: string }>;
}

// =============================================================================
// DEDUPE KEY BUILDERS
// =============================================================================

/**
 * Dedupe key formats for different entity types.
 * These are the canonical key structures used for idempotent operations.
 */
export interface DedupeKeyFormat {
  /**
   * File dedupe: hash + set
   * Format: `file:{contentHash}:{embeddingSetId}`
   */
  file: `file:${string}:${string}`;

  /**
   * Chunk dedupe: file + index
   * Format: `chunk:{fileId}:{chunkIndex}`
   */
  chunk: `chunk:${string}:${number}`;

  /**
   * Embedding job dedupe: chunk + set + model
   * Format: `embed:{chunkId}:{embeddingSetId}:{modelKey}`
   */
  embedJob: `embed:${string}:${string}:${string}`;
}

// =============================================================================
// STREAMING IMPORT TYPES (BST-156)
// =============================================================================

/**
 * Content reader interface for lazy/on-demand file content loading.
 *
 * This replaces the `fileContents: Record<string, string>` pattern
 * which loads all content into memory upfront. With ContentReader,
 * content is loaded one file at a time and can be released after processing.
 *
 * @example
 * ```typescript
 * const reader: ContentReader = {
 *   async readContent(path) {
 *     const content = await fs.readFile(path, 'utf-8');
 *     return content;
 *   }
 * };
 * ```
 */
export interface ContentReader {
  /**
   * Read content for a single file path on-demand.
   *
   * @param compositeKey - The file's composite key (folderId:path format)
   * @returns File content as string, or null if file cannot be read
   */
  readContent(compositeKey: string): Promise<string | null>;

  /**
   * Optional: prefetch a batch of files for network optimization.
   * Called before processing a batch to allow parallel network requests.
   *
   * @param compositeKeys - Array of composite keys to prefetch
   */
  prefetchBatch?(compositeKeys: string[]): Promise<void>;

  /**
   * Optional: release content after processing to allow GC.
   * Called after a file has been fully processed (imported + chunked).
   *
   * @param compositeKey - The file's composite key
   */
  releaseContent?(compositeKey: string): void;
}

/**
 * Streaming import configuration options.
 */
export interface StreamingImportOptions {
  /**
   * Number of files to process concurrently.
   * Higher values increase throughput but use more memory.
   * @default 1 (sequential processing for minimum memory)
   */
  concurrency?: number;

  /**
   * Number of files to prefetch ahead of processing.
   * Useful when content comes from network (e.g., Web API).
   * @default 0 (no prefetch)
   */
  prefetchAhead?: number;

  /**
   * Whether to continue processing on individual file errors.
   * If false, first error stops the entire pipeline.
   * @default true (isolate errors to individual files)
   */
  continueOnError?: boolean;

  /**
   * Progress update throttle in milliseconds.
   * Lower values = more frequent updates but higher overhead.
   * @default 100
   */
  progressThrottleMs?: number;
}

/**
 * Result from streaming a single file through the pipeline.
 */
export interface StreamingFileResult {
  /** File path that was processed */
  path: string;
  /** Composite key (folderId:path) */
  compositeKey: string;
  /** Whether import succeeded */
  imported: boolean;
  /** Whether file already existed */
  existed: boolean;
  /** File record ID if successful */
  fileId?: FileId;
  /** Number of chunks created */
  chunksCreated: number;
  /** Number of embedding jobs enqueued */
  jobsEnqueued: number;
  /** Error message if failed */
  error?: string;
  /** Processing time in ms */
  durationMs: number;
}

/**
 * Streaming import completion result.
 */
export interface StreamingImportResult {
  /** All file results */
  files: StreamingFileResult[];
  /** Total files processed */
  totalFiles: number;
  /** Successfully imported files */
  successCount: number;
  /** Files with errors */
  errorCount: number;
  /** Total chunks created */
  totalChunks: number;
  /** Total jobs enqueued */
  totalJobsEnqueued: number;
  /** Total duration in ms */
  durationMs: number;
  /** Peak memory usage estimate (if available) */
  peakMemoryMb?: number;
}

// =============================================================================
// DATABASE MAPPING TYPES
// =============================================================================

/**
 * Mapping between pipeline types and database schema.
 *
 * This documents the relationship between the orchestrator's domain model
 * and the storage layer.
 *
 * | Pipeline Type    | DB Table      | Key Mapping                |
 * |------------------|---------------|----------------------------|
 * | FileImportOutput | file_records  | fileId → id                |
 * | ChunkOutput      | file_chunks   | chunkId → id               |
 * | EmbeddingOutput  | file_chunks   | embedding → embedding col  |
 * | EmbedJobPayload  | job_queue     | dedupeKey → dedupe_key     |
 */
export interface DbMapping {
  fileRecords: {
    table: 'file_records';
    primaryKey: 'id';
    dedupeKey: 'content_hash';
    fields: {
      id: FileId;
      path: string;
      name: string;
      size: number;
      content: string | null;
      contentHash: ContentHash | null;
      tokenCount: number | null;
      embeddingSetId: EmbeddingSetId | null;
      chunksCount: number | null;
      chunkingStrategy: ChunkingStrategy | null;
    };
  };
  fileChunks: {
    table: 'file_chunks';
    primaryKey: 'id';
    dedupeKey: 'content_hash';
    fields: {
      id: ChunkId;
      fileRecordId: FileId;
      chunkIndex: number;
      content: string;
      contentHash: ContentHash;
      tokenCount: number;
      embedding: number[] | null;
      embeddingSetId: EmbeddingSetId | null;
      embeddingHash: ContentHash | null;
    };
  };
  jobQueue: {
    table: 'job_queue';
    primaryKey: 'id';
    dedupeKey: 'dedupe_key';
    fields: {
      id: JobId;
      queue: string;
      jobType: 'embed_chunk';
      payload: EmbedJobPayload;
      state: JobState;
      dedupeKey: string;
    };
  };
}
