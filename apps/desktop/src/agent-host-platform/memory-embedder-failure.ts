import {
  extractProviderRunError,
  isLocalRunErrorClassification,
} from '@brainstrike/agent/provider-runtime';
import type { HostedProviderType } from '@brainstrike/embeddings/provider-core';
import { HostedEmbeddingError, hostedRefusal } from '../hosted-embedding-error';

/**
 * BST-2202: a semantic recall embedder's raw failure, read with the hosted
 * embedding classification indexing uses (`hostedRefusal`). Only the
 * provider's own evidence is read: an HTTP status, or a call that got no
 * response. A failure that never crossed to the provider has no hosted
 * classification, and the memory step reads it as the internal fault.
 */
export function hostedMemoryEmbedderFailure(
  provider: HostedProviderType,
  cause: unknown
): { readonly detail: string; readonly httpStatus?: number } | undefined {
  const evidence = extractProviderRunError(cause);
  if (isLocalRunErrorClassification(evidence.code)) {
    return;
  }
  const { httpStatus } = evidence;
  const classified = hostedRefusal(
    provider,
    httpStatus === undefined
      ? {
          originalError: cause instanceof Error ? cause : new Error(String(cause)),
          provider,
          type: 'network_error',
        }
      : httpStatus === 429
        ? { provider, type: 'rate_limit_exceeded' }
        : {
            message: 'The embedding request failed.',
            provider,
            statusCode: httpStatus,
            type: 'api_error',
          }
  );
  return classified instanceof HostedEmbeddingError
    ? { detail: classified.message, ...(httpStatus === undefined ? {} : { httpStatus }) }
    : undefined;
}
