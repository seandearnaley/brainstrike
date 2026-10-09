/**
 * The Main-owned data the retrieval tools read (queryEmbeddingSpace,
 * hybridSearch, listEmbeddingSpaces). Main binds its PGlite database
 * (retrieval-store-pglite.ts); the desktop agent host binds typed reads of the
 * same store. Imports no database or Electron module: the host bundle loads it.
 */
import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  EmbeddingSpaceListing,
  HybridSearchOptions,
  HybridSearchResponse,
} from '@brainstrike/db';
import type { HostedProviderType } from '@brainstrike/embeddings/provider-core';

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

/**
 * Main's own PGlite similarity path and hosted query embeddings, used only when
 * no native index serves the request. The agent host never has one: its
 * retrieval always goes through the native index.
 */
export interface LegacyRetrievalStore {
  createSelectionSnapshot(filePaths: readonly string[]): Promise<string>;
  hostedQueryEmbedding(request: {
    readonly dimensions: number;
    readonly modelId: string;
    readonly provider: HostedProviderType;
    readonly query: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<number[]>;
  hybridSearch(
    query: string,
    embedding: number[],
    options: HybridSearchOptions
  ): Promise<HybridSearchResponse>;
  searchSimilar(embedding: number[], options: ChunkSearchOptions): Promise<ChunkSearchResult[]>;
}

export interface RetrievalStore {
  /** The embedding set's model identity; rejects an unknown or invalid set. */
  embeddingSet(embeddingSetId: string): Promise<EmbeddingSetRow>;
  /** Saved embedding spaces, with their catalog stats when asked. */
  embeddingSpaces(options: { readonly includeStats: boolean }): Promise<EmbeddingSpaceListing[]>;
  /** Each file record with its owning root, keyed by id; unknown ids are absent. */
  fileRecords(ids: readonly string[]): Promise<ReadonlyMap<string, FileRecordRow>>;
  readonly legacy?: LegacyRetrievalStore;
}

/** The legacy path's store, or a visible refusal where there is none (the agent host). */
export function requireLegacyRetrievalStore(store: RetrievalStore): LegacyRetrievalStore {
  if (!store.legacy) {
    throw new Error('Retrieval without a native index runs only on Main’s database.');
  }
  return store.legacy;
}
