/**
 * @module @brainstrike/pipeline
 *
 * Indexing Pipeline Orchestrator
 *
 * This package provides the orchestration layer for the
 * File → Chunk → Embed → Vector indexing pipeline.
 *
 * ## Data Model
 *
 * The pipeline uses canonical types and identifiers to ensure consistency:
 *
 * - **FileId**: UUID for file records
 * - **ChunkId**: UUID for file chunks
 * - **EmbeddingSetId**: UUID for embedding configurations
 * - **ContentHash**: SHA-256 hash for deduplication
 *
 * ## Deduplication
 *
 * Each entity type has a dedupe key strategy:
 *
 * - Files: `file:{contentHash}:{embeddingSetId}` - same content in same set
 * - Chunks: `chunk:{fileId}:{chunkIndex}` - same file, same position
 * - Jobs: `embed:{chunkId}:{setId}:{model}` - same chunk, same config
 *
 * @example
 * ```typescript
 * import {
 *   generateFileId,
 *   buildEmbedJobDedupeKey,
 *   type FileImportOutput,
 * } from '@brainstrike/pipeline';
 *
 * // Generate a new file ID
 * const fileId = generateFileId();
 *
 * // Build a dedupe key for job queue
 * const dedupeKey = buildEmbedJobDedupeKey(chunkId, setId, 'text-embedding-3-small');
 * ```
 */

// Identifiers
export {
  buildChunkDedupeKey,
  buildEmbedJobDedupeKey,
  // Dedupe key builders
  buildFileDedupeKey,
  generateChunkId,
  generateEmbeddingSetId,
  // ID generators
  generateFileId,
  // Hash utilities
  generateHash,
  generateHashSync,
  generateJobId,
  isValidContentHash,
  // Validation
  isValidUUID,
  type ParsedDedupeKey,
  parseDedupeKey,
  toChunkId,
  toContentHash,
  toEmbeddingSetId,
  // Type casts
  toFileId,
} from './identifiers.js';
// Types
export type {
  ChunkId,
  ChunkingInput,
  ChunkingOutput,
  ChunkingStrategy,
  ChunkOutput,
  ContentHash,
  DbMapping,
  // Schema mapping
  DedupeKeyFormat,
  EmbeddingInput,
  EmbeddingOutput,
  EmbeddingSetId,
  // Job types
  EmbedJobPayload,
  // Branded IDs
  FileId,
  // Stage types
  FileImportInput,
  FileImportOutput,
  JobId,
  JobState,
  PipelineProgress,
  // Progress types
  StageProgress,
} from './types.js';
