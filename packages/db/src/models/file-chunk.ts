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
   * When `false` (the default), returned rows omit the heavy embedding vector
   * (~6KB/row over IPC) and instead carry `embeddingDimensions` (via a cheap
   * `vector_dims()` projection). No search consumer needs the vector values —
   * only ids, scores, and the dimension count — so the vector is projected away
   * by default. Pass `true` only when a caller genuinely needs the raw vector
   * (e.g. client-side re-embedding); ranking is unaffected either way because
   * the distance is computed in SQL.
   */
  includeEmbedding?: boolean;
  limit?: number;
  /** Optional workspace-root scope (file_records.root_id). */
  rootId?: string;
  /** Optional multi-root workspace scope (file_records.root_id ∈ rootIds). Empty array matches nothing. */
  rootIds?: readonly string[];
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
  /**
   * Optional embedding-set scope, using the same set-membership identity as
   * coverage accounting (see `getCoverageForSet`): a chunk matches when its own
   * `embedding_set_id` equals the given set, OR its `embedding_set_id` is NULL
   * (pending embedding) and its file record carries the set. Match semantics
   * (tsquery) are unaffected — this is purely an additional filter. Omit for
   * the historical unscoped behavior.
   */
  embeddingSetId?: string;
  /** Optional allowlist of file paths to scope results */
  filePaths?: readonly string[];
  /** Filter by specific file record ID */
  fileRecordId?: string;
  /**
   * When `false` (the default), returned rows omit the heavy embedding vector
   * and instead carry `embeddingDimensions` (via a cheap `vector_dims()`
   * projection). FTS never needs the vector, so it is projected away by default.
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
  /**
   * Text search configuration/language for MATCHING (default: 'english').
   * Ordering is BM25 (pg_textsearch) and always uses the bm25 index's own
   * `text_config='english'` (migration 053) regardless of this option — a
   * non-english match config can therefore see stemming-mismatch ties in the
   * ordering. Match semantics are unaffected.
   */
  language?: string;
  /** Maximum number of results to return (default: 10) */
  limit?: number;
  /** Query parsing mode (default: 'websearch' for user-friendly syntax) */
  queryMode?: FTSQueryMode;
  /**
   * @deprecated INERT since the BM25 ordering swap (migration 053): ranking is
   * BM25 (which has its own length normalization via the index's `b`
   * parameter), so ts_rank normalization flags no longer apply and this option
   * is ignored. Kept only to avoid a type-surface break for existing callers.
   */
  rankNormalization?: number;
  /** Optional multi-root workspace scope (file_records.root_id ∈ rootIds). Empty array matches nothing. */
  rootIds?: readonly string[];
  /** Optional snapshot id referencing a persisted selection allowlist */
  selectionSnapshotId?: string;
  /**
   * Minimum FTS rank score threshold (default: 0, no threshold). The rank is a
   * NEGATED BM25 score (higher = more relevant) and is UNBOUNDED and
   * corpus-dependent — unlike the old ts_rank ~0–1 range — so fixed cutoffs
   * from the ts_rank era do not transfer. Derive thresholds from observed
   * ranks, or leave at 0.
   */
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
  /**
   * FTS relevance rank score: negated BM25 (higher = more relevant, unbounded,
   * corpus-dependent). Matching is tsvector-based; only ordering is BM25.
   */
  rank: number;
}
