/**
 * Main's hybridSearch: the shared hybrid core over Main's own retrieval store.
 * The agent host runs the same core over typed reads of this store.
 */
import type { HybridSearchInput, RuntimeData } from '@brainstrike/agent';
import { type HybridSearchToolResult, runHybridSearchWith } from './hybrid-search-core';
import type { RetrievalToolDependencies } from './retrieval-core';
import { pgliteRetrievalStore } from './retrieval-store-pglite';

export function runHybridSearch(
  input: HybridSearchInput,
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies = {},
  signal?: AbortSignal
): Promise<HybridSearchToolResult> {
  return runHybridSearchWith(input, runtimeData, dependencies, pgliteRetrievalStore(), signal);
}
