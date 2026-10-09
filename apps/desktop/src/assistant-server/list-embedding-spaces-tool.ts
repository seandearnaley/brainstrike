/**
 * Main's listEmbeddingSpaces: the shared listing core over Main's own store.
 * The agent host runs the same core over typed reads of this store.
 */
import type { ListEmbeddingSetsInput, RuntimeData } from '@brainstrike/agent';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { runListEmbeddingSpacesWith } from './list-embedding-spaces-core';
import { pgliteRetrievalStore } from './retrieval-store-pglite';

export function runListEmbeddingSpaces(
  input: ListEmbeddingSetsInput,
  runtimeData: RuntimeData | undefined,
  nativeIndexSearch?: IndexSearchCapability
): ReturnType<typeof runListEmbeddingSpacesWith> {
  return runListEmbeddingSpacesWith(input, runtimeData, nativeIndexSearch, pgliteRetrievalStore());
}
