/**
 * The Main-owned data the retrieval tools read (queryEmbeddingSpace,
 * hybridSearch, listEmbeddingSpaces). Main binds its PGlite database
 * (retrieval-store-pglite.ts); the desktop agent host binds typed reads of the
 * same store. Imports no database or Electron module: the host bundle loads it.
 */
import type { EmbeddingSpaceListing } from '@brainstrike/db';

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
