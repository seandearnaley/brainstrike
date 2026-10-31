import type { EmbeddingProviderType } from '@brainstrike/indexing-contract';
import { hostedRefusal } from '../hosted-embedding-error';

/**
 * BST-2202: a semantic recall embedder's raw failure, read with the hosted
 * embedding classification indexing uses (`hostedRefusal`). A failure that
 * never crossed to the provider has no hosted classification, and the memory
 * step reads it as the internal fault.
 */
export function hostedMemoryEmbedderFailure(
  provider: EmbeddingProviderType,
  cause: unknown
): { readonly detail: string; readonly httpStatus?: number } | undefined {
  const classified = hostedRefusal(provider, cause);
  if (!classified) {
    return;
  }
  const { httpStatus } = classified;
  return { detail: classified.message, ...(httpStatus === undefined ? {} : { httpStatus }) };
}
