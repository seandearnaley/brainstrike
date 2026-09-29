/**
 * Thread search index models.
 *
 * Brainstrike-owned hybrid-search state over the Mastra-owned
 * `mastra_threads` / `mastra_messages` tables (migration 067). The index row
 * is derived state: extracted message text + lexical tsvector + optional
 * per-message embedding, keyed by message id with no FKs to the Mastra
 * tables (see the migration header for the ownership ruling).
 */

/** Minimal database seam (mirrors PromptItemDatabase). */
export interface ThreadSearchDatabase {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  /**
   * Optional atomic multi-statement transaction (the DbHandle `runTransaction`
   * IPC primitive from #1141). When present, the vector search arm runs its
   * `SET LOCAL` HNSW tuning + SELECT inside one transaction here. Named to match
   * `DbHandle.runTransaction` — deliberately NOT `transaction`, which would
   * collide with PGlite's callback-style method of that name.
   */
  runTransaction?: (
    statements: { params?: unknown[]; sql: string }[],
    resultIndex: number
  ) => Promise<{ rows: unknown[] }>;
  /**
   * Optional callback-style transaction (PGlite / ScheduledDbHandle shape) —
   * the WEB production path. Holds the single PGlite connection lock for the
   * callback's duration, so concurrent scheduled work (e.g. the thread-search
   * controller's embedding-backlog writes) cannot interleave inside the open
   * transaction. A query-only handle is rejected because separate BEGIN/COMMIT
   * calls do not hold this transport lock.
   */
  transaction?: <T>(
    fn: (tx: {
      query: <R = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
      ) => Promise<{ rows: R[] }>;
    }) => Promise<T>
  ) => Promise<T | undefined>;
}

/** Singleton embedding profile row (same shape as PromptEmbeddingProfile). */
export interface ThreadSearchEmbeddingProfile {
  dimensions: number;
  distance: 'cosine' | 'l2' | 'ip';
  id: string;
  modelId: string;
  modelKey: string;
}

export interface ThreadSearchSyncOptions {
  /** Rows per new-message insert batch (default 500). */
  batchSize?: number;
  /** Max orphaned rows garbage-collected per sync (default 1000). */
  gcLimit?: number;
  /** Max insert batches per sync call (default 20). */
  maxBatches?: number;
  /** Max threads re-extracted per refresh pass (default 200). */
  refreshThreadBatch?: number;
}

export interface ThreadSearchSyncResult {
  deletedOrphans: number;
  inserted: number;
  refreshed: number;
}

export interface ThreadMessageFtsOptions {
  /** Generate `<mark>`-highlighted headlines (default true). */
  includeHeadline?: boolean;
  limit: number;
  resourceId: string;
}

export interface ThreadMessageFtsMatch {
  headline: string | null;
  messageCreatedAt: Date;
  messageId: string;
  rank: number;
  role: string;
  threadId: string;
}

export interface ThreadMessageVectorOptions {
  limit: number;
  resourceId: string;
  /** Minimum cosine similarity (default 0.35). */
  threshold?: number;
}

export interface ThreadMessageVectorMatch {
  messageCreatedAt: Date;
  messageId: string;
  role: string;
  similarity: number;
  snippet: string;
  threadId: string;
}

export interface ThreadTitleSearchOptions {
  limit: number;
  resourceId: string;
}

export interface ThreadTitleMatch {
  similarity: number;
  threadId: string;
  title: string;
}

export interface ThreadMessagePendingEmbedding {
  contentHash: string;
  contentText: string;
  messageId: string;
}

export interface StoreThreadMessageEmbeddingInput {
  /** CAS guard: the hash observed when the row was listed for embedding. */
  contentHash: string;
  embedding: readonly number[];
  messageId: string;
  /** CAS guard: the profile model that produced this vector. */
  modelKey: string;
}

export interface MarkThreadMessageEmbeddingErrorInput {
  contentHash: string;
  error: string;
  messageId: string;
}

/**
 * Honest coverage counters for the search UI: the semantic arm's readiness is
 * always visible, never silently degraded.
 */
export interface ThreadSearchCoverage {
  /** Index rows with non-empty extracted text (the embeddable set). */
  embeddableMessages: number;
  /** Embeddable rows with a stored vector. */
  embeddedMessages: number;
  /** Rows whose embedding attempt recorded an error. */
  erroredMessages: number;
  /** Rows present in the index. */
  indexedMessages: number;
  /** All mastra messages for the resource (indexed or not). */
  totalMessages: number;
}
