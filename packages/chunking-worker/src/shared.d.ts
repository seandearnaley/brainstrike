/**
 * Shared types for canonical chunking: request options, portable chunks and
 * the per-file chunking result.
 */

import type {
  ResolvedChunkingStrategy,
  ChunkingStrategy as SharedChunkingStrategy,
} from '@brainstrike/text-splitter';
import type { PortableSymbol, PortableSymbolRef } from './extract-symbols';
import type { ChunkSkipCode } from './portable-chunking';

/**
 * Chunking strategy determines how content is split into chunks.
 */
export type ChunkingStrategy = SharedChunkingStrategy;

/**
 * Type of chunk created (used for metadata).
 */
export type ChunkType = 'text' | 'sentence' | 'recursive';

/**
 * Options for a chunking request.
 */
export interface ChunkingRequestOptions {
  /** When true, allows chunking beyond maxChunkableSize */
  allowLargeFiles?: boolean | undefined;
  /** When true, honor the provided strategy without applying file-type heuristics */
  forceStrategy?: boolean | undefined;
  /** Skip file-type recommendations and only enforce global safety caps when true */
  ignoreFileTypeRecommendations?: boolean | undefined;
  maxTokens?: number | undefined;
  /** Optional override for the global max token budget per chunk */
  maxTokensCap?: number | undefined;
  overlap?: number | undefined;
  separators?: string[] | undefined;
  strategy: ChunkingStrategy;
  /** If true, derive character limits from measured chars/token for this content */
  tokenTrueSizing?: boolean | undefined;
}

/**
 * A portable chunk that can be serialized across a process boundary.
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
  /** Structured reason for a deliberate skip */
  skipCode?: ChunkSkipCode;
  /** True if the file was skipped (lock file, binary, etc.) */
  skipped: boolean;
  /** Reason for skipping, if applicable */
  skipReason?: string;
  /** Number of candidate chunks dropped because source line/offset ranges could not be resolved */
  sourceRangeSkippedChunks?: number;
  /** Strategy that was actually used after file-type heuristics */
  strategyUsed: ResolvedChunkingStrategy;
  /** Name-based symbol references from the same parse (BST-919); absent when
   * the file was not AST-chunked or extraction degraded. */
  symbolRefs?: PortableSymbolRef[];
  /** Symbol definitions from the same parse (BST-919). */
  symbols?: PortableSymbol[];
  /** Total tokens across all chunks */
  totalTokens: number;
  type: 'result';
}
