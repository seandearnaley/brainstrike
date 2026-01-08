export type FileChunk = {
  id: string;
  fileRecordId: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  tokenCount: number;
  chunkType: 'text' | 'code' | 'sentence' | 'recursive';
  chunkSize: number;
  embedding?: number[];
  embeddingSetId?: string;
  embeddingUpdatedAt?: string;
  embeddingHash?: string;
  createdAt: string;
  updatedAt: string;
};

export type FileChunkInsert = {
  id: string;
  fileRecordId: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  tokenCount: number;
  chunkType: 'text' | 'code' | 'sentence' | 'recursive';
  chunkSize: number;
  embedding?: number[];
  embeddingSetId?: string;
  embeddingUpdatedAt?: string;
  embeddingHash?: string;
  createdAt: string;
  updatedAt: string;
};

export type FileChunkUpdate = {
  id: string;
  content?: string;
  contentHash?: string;
  tokenCount?: number;
  chunkType?: 'text' | 'code' | 'sentence' | 'recursive';
  chunkSize?: number;
  embedding?: number[];
  embeddingSetId?: string;
  embeddingUpdatedAt?: string;
  embeddingHash?: string;
  updatedAt: string;
};

export type ChunkSearchResult = {
  chunk: FileChunk;
  similarity: number;
  rank: number;
};

export type ChunkSearchOptions = {
  limit?: number;
  threshold?: number;
  fileRecordId?: string;
  chunkType?: 'text' | 'code' | 'sentence' | 'recursive';
  embeddingSetId?: string;
  /** Optional allowlist of file paths to scope results (relative to project root). */
  filePaths?: readonly string[];
  /** Optional snapshot id referencing a persisted selection allowlist. */
  selectionSnapshotId?: string;
};

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
export type FTSSearchOptions = {
  /** Maximum number of results to return (default: 10) */
  limit?: number;
  /** Minimum FTS rank score threshold (default: 0, no threshold) */
  threshold?: number;
  /** Filter by specific file record ID */
  fileRecordId?: string;
  /** Filter by chunk type */
  chunkType?: 'text' | 'code' | 'sentence' | 'recursive';
  /** Optional allowlist of file paths to scope results */
  filePaths?: readonly string[];
  /** Optional snapshot id referencing a persisted selection allowlist */
  selectionSnapshotId?: string;
  /** Query parsing mode (default: 'websearch' for user-friendly syntax) */
  queryMode?: FTSQueryMode;
  /** Text search configuration/language (default: 'english') */
  language?: string;
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
};

/**
 * Result from full-text search with FTS-specific metadata
 */
export type FTSSearchResult = {
  /** The matched chunk */
  chunk: FileChunk;
  /** FTS relevance rank score (higher = more relevant) */
  rank: number;
  /** Position in result set (1-indexed) */
  position: number;
  /** Headline snippet with search terms highlighted (if requested) */
  headline?: string;
};
