import type {
  ResolvedChunkingStrategy,
  ChunkingStrategy as SharedChunkingStrategy,
} from '@brainstrike/text-splitter';

export type { ResolvedChunkingStrategy } from '@brainstrike/text-splitter';

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
  /** Raw file content as string */
  content: string;
  /** Target embedding set for this file */
  embeddingSetId?: EmbeddingSetId;
  /** File name (basename) */
  name: string;
  /** Absolute file path */
  path: string;
  /** File size in bytes */
  size: number;
}

/**
 * Output from import stage - stored file record reference.
 */
export interface FileImportOutput {
  /** Content hash used for deduplication */
  contentHash: ContentHash;
  /** Assigned file record ID */
  fileId: FileId;
  /** Whether this was a new import or existing file */
  isNew: boolean;
  /** Token count from import */
  tokenCount: number;
}

/**
 * Chunking strategy determines how content is split.
 */
export type ChunkingStrategy = SharedChunkingStrategy;

/**
 * Input to the chunking stage.
 */
export interface ChunkingInput {
  /** File content to chunk */
  content: string;
  /** File record ID to chunk */
  fileId: FileId;
  /** File name for strategy hints */
  fileName: string;
  /** File path for strategy hints */
  filePath: string;
  /** Maximum tokens per chunk */
  maxTokens?: number;
  /** Overlap between chunks */
  overlap?: number;
  /** Chunking strategy to use */
  strategy: ChunkingStrategy;
}

/**
 * Single chunk output from chunking stage.
 */
export interface ChunkOutput {
  /** Sequential index within the file (0-based) */
  chunkIndex: number;
  /** Maximum chunk size used */
  chunkSize: number;
  /** Chunk type classification */
  chunkType: 'text' | 'code' | 'sentence' | 'recursive';
  /** Chunk text content */
  content: string;
  /** SHA-256 hash of content */
  contentHash: ContentHash;
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

/**
 * Output from chunking stage.
 */
export interface ChunkingOutput {
  /** Created chunks */
  chunks: ChunkOutput[];
  /** Source file record ID */
  fileId: FileId;
  /** Whether file was skipped (binary, lock file, etc.) */
  skipped: boolean;
  /** Reason for skipping, if applicable */
  skipReason?: string;
  /** Strategy actually used (may differ from requested) */
  strategyUsed: ResolvedChunkingStrategy;
  /** Total tokens across all chunks */
  totalTokens: number;
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
  /** Hash of the embedding for cache invalidation */
  embeddingHash: ContentHash;
  /** Model key used */
  modelKey: string;
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
  /** Chunk index for ordering */
  chunkIndex: number;
  /** Content hash for caching/dedupe */
  contentHash: ContentHash;
  /** Embedding set this job belongs to */
  embeddingSetId: EmbeddingSetId;
  /** Original file ID for tracking */
  fileId: FileId;
  /** Model key for embedding */
  modelKey: string;
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
  /** Items completed (success or skip) */
  completed: number;
  /** Current item being processed */
  currentItem?: string;
  /** Items that failed */
  failed: number;
  /** Items currently in progress */
  inProgress: number;
  /** Total items to process */
  total: number;
}

/**
 * Aggregated progress across all pipeline stages.
 */
export interface PipelineProgress {
  /** Chunking stage progress */
  chunking: StageProgress;
  /** Overall end time (if complete) */
  completedAt?: string;
  /** Embedding stage progress */
  embedding: StageProgress;
  /** Import stage progress */
  import: StageProgress;
  /** Current pipeline phase */
  phase: 'importing' | 'chunking' | 'embedding' | 'complete' | 'error';
  /** Recent errors for diagnostics */
  recentErrors: Array<{ stage: string; item: string; error: string; timestamp: string }>;
  /** Overall start time */
  startedAt: string;
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
   * Chunk dedupe: file + index
   * Format: `chunk:{fileId}:{chunkIndex}`
   */
  chunk: `chunk:${string}:${number}`;

  /**
   * Embedding job dedupe: chunk + set + model
   * Format: `embed:{chunkId}:{embeddingSetId}:{modelKey}`
   */
  embedJob: `embed:${string}:${string}:${string}`;
  /**
   * File dedupe: hash + set
   * Format: `file:{contentHash}:{embeddingSetId}`
   */
  file: `file:${string}:${string}`;
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
   * Optional: prefetch a batch of files for network optimization.
   * Called before processing a batch to allow parallel network requests.
   *
   * @param compositeKeys - Array of composite keys to prefetch
   */
  prefetchBatch?(compositeKeys: string[]): Promise<void>;
  /**
   * Read content for a single file path on-demand.
   *
   * @param compositeKey - The file's composite key (folderId:path format)
   * @returns File content as string, or null if file cannot be read
   */
  readContent(compositeKey: string): Promise<string | null>;

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
   * Whether to continue processing on individual file errors.
   * If false, first error stops the entire pipeline.
   * @default true (isolate errors to individual files)
   */
  continueOnError?: boolean;

  /**
   * Number of files to prefetch ahead of processing.
   * Useful when content comes from network (e.g., Web API).
   * @default 0 (no prefetch)
   */
  prefetchAhead?: number;

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
  /** Number of chunks created */
  chunksCreated: number;
  /** Composite key (folderId:path) */
  compositeKey: string;
  /** Processing time in ms */
  durationMs: number;
  /** Error message if failed */
  error?: string;
  /** Whether file already existed */
  existed: boolean;
  /** File record ID if successful */
  fileId?: FileId;
  /** Whether import succeeded */
  imported: boolean;
  /** Number of embedding jobs enqueued */
  jobsEnqueued: number;
  /** File path that was processed */
  path: string;
}

/**
 * Streaming import completion result.
 */
export interface StreamingImportResult {
  /** Total duration in ms */
  durationMs: number;
  /** Files with errors */
  errorCount: number;
  /** All file results */
  files: StreamingFileResult[];
  /** Peak memory usage estimate (if available) */
  peakMemoryMb?: number;
  /** Successfully imported files */
  successCount: number;
  /** Total chunks created */
  totalChunks: number;
  /** Total files processed */
  totalFiles: number;
  /** Total jobs enqueued */
  totalJobsEnqueued: number;
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
      startLine: number | null;
      endLine: number | null;
      startOffset: number | null;
      endOffset: number | null;
      embedding: number[] | null;
      embeddingSetId: EmbeddingSetId | null;
      embeddingHash: ContentHash | null;
    };
  };
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
