/**
 * Main's queryEmbeddingSpace: the shared retrieval core over Main's own store.
 * The agent host runs the same core over typed reads of this store.
 */
import type { QueryEmbeddingSpaceInput, RuntimeData } from '@brainstrike/agent';
import {
  type RetrievalToolDependencies,
  type RetrievalToolExecutionResult,
  runQueryEmbeddingSpaceWith,
} from './retrieval-core';
import { pgliteRetrievalStore } from './retrieval-store-pglite';

export function runQueryEmbeddingSpace(
  input: QueryEmbeddingSpaceInput,
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies = {},
  signal?: AbortSignal
): Promise<RetrievalToolExecutionResult> {
  return runQueryEmbeddingSpaceWith(
    input,
    runtimeData,
    dependencies,
    pgliteRetrievalStore(),
    signal
  );
}
