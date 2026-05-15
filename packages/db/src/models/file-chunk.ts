export interface FileChunk {
  chunkIndex: number;
  chunkSize: number;
  chunkType: 'text' | 'code' | 'sentence' | 'recursive';
  content: string;
  contentHash: string;
  createdAt: string;
  embedding?: number[];
  embeddingHash?: string;
  embeddingSetId?: string;
  embeddingUpdatedAt?: string;
  endLine?: number;
  endOffset?: number;
  fileRecordId: string;
  id: string;
  startLine?: number;
  startOffset?: number;
  tokenCount: number;
  updatedAt: string;
}

export interface FileChunkInsert {
  chunkIndex: number;
  chunkSize: number;
  chunkType: 'text' | 'code' | 'sentence' | 'recursive';
  content: string;
  contentHash: string;
  createdAt: string;
  embedding?: number[];
  embeddingHash?: string;
  embeddingSetId?: string;
  embeddingUpdatedAt?: string;
  endLine?: number;
  endOffset?: number;
  fileRecordId: string;
  id: string;
  startLine?: number;
  startOffset?: number;
  tokenCount: number;
  updatedAt: string;
}

export interface FileChunkUpdate {
  chunkSize?: number;
  chunkType?: 'text' | 'code' | 'sentence' | 'recursive';
  content?: string;
  contentHash?: string;
  embedding?: number[];
  embeddingHash?: string;
  embeddingSetId?: string;
  embeddingUpdatedAt?: string;
  endLine?: number;
  endOffset?: number;
  id: string;
  startLine?: number;
  startOffset?: number;
  tokenCount?: number;
  updatedAt: string;
}

export interface ChunkSearchResult {
  chunk: FileChunk;
  rank: number;
  similarity: number;
}

export interface ChunkSearchOptions {
  chunkType?: 'text' | 'code' | 'sentence' | 'recursive';
  embeddingSetId?: string;
  /** Optional allowlist of file paths to scope results (relative to project root). */
  filePaths?: readonly string[];
  fileRecordId?: string;
  limit?: number;
  /** Optional snapshot id referencing a persisted selection allowlist. */
  selectionSnapshotId?: string;
  threshold?: number;
}

/**
 * Query parsing mode for full-text search
 * - 'plain': Simple space-separated words with AND semantics (plainto_tsquery)
 * - 'websearch': Google-like syntax with OR, quotes, -negation (websearch_to_tsquery)
 * - 'phrase': Exact phrase match (phraseto_tsquery)
 */
export type FTSQueryMode = 'plain' | 'websearch' | 'phrase';

/**
 * Options for full-text search on file chunks
 */
export interface FTSSearchOptions {
  /** Filter by chunk type */
  chunkType?: 'text' | 'code' | 'sentence' | 'recursive';
  /** Optional allowlist of file paths to scope results */
  filePaths?: readonly string[];
  /** Filter by specific file record ID */
  fileRecordId?: string;
  /** Text search configuration/language (default: 'english') */
  language?: string;
  /** Maximum number of results to return (default: 10) */
  limit?: number;
  /** Query parsing mode (default: 'websearch' for user-friendly syntax) */
  queryMode?: FTSQueryMode;
  /**
   * Ranking normalization flags (PostgreSQL ts_rank normalization)
   * - 0: Default (no normalization)
   * - 1: Divide by 1 + log(document length)
   * - 2: Divide by document length
   * - 4: Divide by mean harmonic distance between extents
   * - 8: Divide by number of unique words
   * - 16: Divide by 1 + log(unique words)
   * - 32: Divide by itself + 1
   * Can be combined with | (e.g., 1|2 for both normalizations)
   */
  rankNormalization?: number;
  /** Optional snapshot id referencing a persisted selection allowlist */
  selectionSnapshotId?: string;
  /** Minimum FTS rank score threshold (default: 0, no threshold) */
  threshold?: number;
}

/**
 * Result from full-text search with FTS-specific metadata
 */
export interface FTSSearchResult {
  /** The matched chunk */
  chunk: FileChunk;
  /** Headline snippet with search terms highlighted (if requested) */
  headline?: string;
  /** Position in result set (1-indexed) */
  position: number;
  /** FTS relevance rank score (higher = more relevant) */
  rank: number;
}
