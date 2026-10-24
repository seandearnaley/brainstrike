/**
 * The Main-owned data the retrieval tools read (queryEmbeddingSpace,
 * hybridSearch, listEmbeddingSpaces). Main binds its catalog
 * (retrieval-store-catalog.ts); the desktop agent host binds typed reads of the
 * same store. Imports no database or Electron module: the host bundle loads it.
 */

export interface EmbeddingSpaceStats {
  /**
   * Average tokens across chunks that have a recorded token_count; uncounted chunks are excluded.
   */
  readonly averageTokensPerChunk: number;
  readonly embeddedChunks: number;
  readonly fileCount: number;
  readonly tokenizedChunkCount: number;
  readonly totalChunks: number;
  readonly totalTokens: number;
}

export interface EmbeddingSpaceListing {
  readonly createdAt: string;
  readonly description: string | null;
  readonly dimensions: number;
  readonly distance: 'cosine' | 'l2' | 'ip' | null;
  readonly id: string;
  readonly modelId: string;
  readonly modelKey: string;
  readonly name: string | null;
  readonly stats?: EmbeddingSpaceStats;
  readonly statsUnavailableReason?: string;
}

export interface EmbeddingSetRow {
  dimensions: number;
  distance: string | null;
  modelId: string;
  modelKey: string;
}

export interface FileRecordRow {
  id: string;
  name: string;
  path: string;
  rootId: string | null;
  rootName: string | null;
  tokenCount: number | null;
}

export interface RetrievalStore {
  /** The embedding set's model identity; rejects an unknown or invalid set. */
  embeddingSet(embeddingSetId: string): Promise<EmbeddingSetRow>;
  /** Saved embedding spaces, with their catalog stats when asked. */
  embeddingSpaces(options: { readonly includeStats: boolean }): Promise<EmbeddingSpaceListing[]>;
  /** Each file record with its owning root, keyed by id; unknown ids are absent. */
  fileRecords(ids: readonly string[]): Promise<ReadonlyMap<string, FileRecordRow>>;
}
