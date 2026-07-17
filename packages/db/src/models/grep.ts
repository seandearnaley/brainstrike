/** Options for the SQL candidate-selection phase of grep search. */
export interface GrepCandidateOptions {
  /** Case-sensitive matching: uses LIKE instead of ILIKE. */
  caseSensitive: boolean;
  /** Optional embedding-set filter (chunks are duplicated per set). */
  embeddingSetId?: string;
  /** Optional exact-path allowlist (file_records.path values). */
  filePaths?: readonly string[];
  /**
   * Pre-escaped LIKE pattern (no surrounding wildcards — the repository adds
   * them), or null for an unfiltered bounded scan (regex with no extractable
   * literal).
   */
  likePattern: string | null;
  /** Maximum candidate chunks to return. */
  limit: number;
  /** Optional workspace-root filter (file_records.root_id). */
  rootId?: string;
  /** Optional multi-root workspace filter (file_records.root_id ∈ rootIds). */
  rootIds?: readonly string[];
}

/** One candidate chunk for JS-side line matching. */
export interface GrepCandidate {
  /** Owning chunk id (file_chunks.id). */
  chunkId: string;
  content: string;
  /** 1-based last line of the chunk within its file; null when unindexed. */
  endLine: number | null;
  filePath: string;
  /** Owning workspace root id (file_records.root_id); null for legacy/unrooted files. */
  rootId?: string | null;
  /** Owning workspace root display name (roots.display_name); null when unrooted. */
  rootName?: string | null;
  /** 1-based first line of the chunk within its file; null when unindexed. */
  startLine: number | null;
}
