import { callBoundary } from '@brainstrike/assistant-contract/boundary-result';
import type { QueryEmbeddingRequest } from '../ipc-domains/index-search.contract';

/** Main embeds the query with the index's hosted model; an aborted search drops the answer. */
export async function generateDesktopQueryEmbedding(
  request: QueryEmbeddingRequest,
  options: { readonly signal: AbortSignal }
): Promise<readonly number[]> {
  const { signal } = options;
  signal.throwIfAborted();
  const bridge = window.indexSearch;
  if (!bridge) {
    throw new Error('The desktop index search capability is unavailable.');
  }
  const embedding = await callBoundary(() => bridge.embedQuery(request));
  signal.throwIfAborted();
  return embedding;
}
