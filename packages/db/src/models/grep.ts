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
  /** Optional root id to disambiguate duplicate relative paths across roots. */
  rootId?: string;
}

/** One candidate chunk for JS-side line matching. */
export interface GrepCandidate {
  content: string;
  filePath: string;
  /** Durable root id for multi-root disambiguation; absent for legacy rows. */
  rootId?: string | null;
  /** 1-based first line of the chunk within its file; null when unindexed. */
  startLine: number | null;
}
