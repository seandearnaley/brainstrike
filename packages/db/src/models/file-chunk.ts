export interface FileChunk {
  chunkIndex: number;
  chunkSize: number;
  chunkType: 'text' | 'code' | 'sentence' | 'recursive';
  content: string;
  contentHash: string;
  createdAt: string;
  embedding?: number[];
  /**
   * Dimension count of the stored embedding. Equal to `embedding.length` when
   * the vector is loaded, but also populated (via the cheap `vector_dims()`
   * projection) when a search omits the heavy vector payload — so consumers can
   * show "N dims" without materializing the array.
   */
  embeddingDimensions?: number;
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
  /**
   * Per-query `hnsw.ef_search` override (widens the ANN candidate window).
   * Falls back to the `HNSW_EF_SEARCH` env var, then the shared default.
   * Clamped to a safe range before use.
   */
  efSearch?: number;
  embeddingSetId?: string;
  /** Optional allowlist of file paths to scope results (relative to project root). */
  filePaths?: readonly string[];
  fileRecordId?: string;
  /**
   * When `false`, returned rows omit the heavy embedding vector and instead
   * carry `embeddingDimensions` (via a cheap `vector_dims()` projection). Use
   * for large fan-out reads (e.g. hybrid RRF source pools) where the vector
   * values are never used — only ids, scores, and the dimension count.
   * Default `true` (full vector returned).
   */
  includeEmbedding?: boolean;
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
  /**
   * When `false`, returned rows omit the heavy embedding vector and instead
   * carry `embeddingDimensions` (via a cheap `vector_dims()` projection). FTS
   * never needs the vector, so hybrid source-pool reads pass `false`.
   * Default `true` (full vector returned).
   */
  includeEmbedding?: boolean;
  /**
   * When `false`, skips per-row `ts_headline()` generation (one of Postgres's
   * costliest functions). Use for large fan-out reads whose consumer won't
   * render the highlighted snippet (e.g. the hybrid UI source pool), where
   * generating a headline for every candidate is wasted work.
   * Default `true` (headline generated).
   */
  includeHeadline?: boolean;
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
