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

// Chunking stage (BST-157)
export {
  type BackgroundBackfillProgress,
  type BackgroundBackfillSnapshot,
  type EmbeddingCoverageSnapshot,
  getSupersededBackgroundBackfillIds,
  isBackgroundIndexingBackfillRequestId,
  needsEmbeddingBackfill,
  selectRecoverableBackgroundBackfill,
} from './background-indexing-orchestrator.js';
export {
  type ChunkingBatchInput,
  type ChunkingBatchResult,
  type ChunkingProgressCallback,
  type ChunkingRequestOptions,
  type ChunkingStage,
  type ChunkingStageConfig,
  type ChunkingStageProgress,
  type ChunkingWorkerPortLike,
  createChunkingStage,
  getRecommendedStrategy,
  type PortableChunk,
  type WorkerChunkResult,
} from './chunking-stage.js';
export {
  createEmbeddingJobQueuePort,
  type DurableEmbeddingJobQueue,
  type EmbeddingJobQueuePortConfig,
} from './embedding-job-queue-port.js';
// Embedding stage (BST-158)
export {
  createEmbeddingStage,
  type EmbeddingBatchInput,
  type EmbeddingBatchResult,
  type EmbeddingEnqueueProgress,
  type EmbeddingEnqueueProgressCallback,
  type EmbeddingStage,
  type EmbeddingStageConfig,
  type EnqueueChunksInput,
  type EnqueueChunksOutput,
  type EnqueuedJob,
  type EnqueueJobParams,
  type JobQueueLike,
} from './embedding-stage.js';
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
// Pipeline controls (BST-160)
export {
  createPipelineController,
  describeState,
  getAvailableActions,
  isActiveState,
  isTerminalState,
  type PipelineController,
  type PipelineControllerConfig,
  type PipelineState,
  type StateChangeCallback,
  type StateChangeMetadata,
} from './pipeline-controller.js';
// Progress aggregation (BST-159)
export {
  calculateOverallPercentage,
  createProgressAggregator,
  formatProgress,
  getTotalCounts,
  hasFailures,
  type PipelineError,
  type PipelineTotals,
  type ProgressAggregator,
  type ProgressAggregatorConfig,
  type ProgressCallback,
  type StageUpdate,
} from './progress-aggregator.js';
// Schema health + recovery (BST-161)
export {
  type CorruptionMetrics,
  createSchemaHealthChecker,
  formatHealthStatus,
  getRecommendedActions,
  type HealthCheckDb,
  hasRecoverableIssues,
  isSchemaReady,
  type RecoveryResult,
  type SchemaHealthChecker,
  type SchemaHealthSummary,
  type TableHealthResult,
} from './schema-health.js';
// Streaming orchestrator (BST-156)
export {
  type FileProcessResult,
  type ProcessFileCallback,
  type StreamingImportInput,
  type StreamingProgress,
  type StreamingProgressCallback,
  streamingImport,
} from './streaming-orchestrator.js';
// Types
export type {
  ChunkId,
  ChunkingInput,
  ChunkingOutput,
  ChunkingStrategy,
  ChunkOutput,
  ContentHash,
  // Streaming types (BST-156)
  ContentReader,
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
  StreamingFileResult,
  StreamingImportOptions,
  StreamingImportResult,
} from './types.js';
