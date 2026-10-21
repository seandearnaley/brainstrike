import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract/boundary-failure';
import type { EmbeddingRequestProgress } from '@brainstrike/embeddings';
import { createLogger } from '@brainstrike/logging';
import type { EmbeddingHostDocumentEmbeddingsRequest } from './embedding-host-shared';
import {
  embeddingHostUnresponsiveError,
  embeddingHostUnresponsiveStage,
} from './embedding-host-unresponsive';
import type {
  HostRequestTimeoutContext,
  HostRequestTimeoutDecision,
} from './platform/host-request-channel';

const logger = createLogger('EmbeddingHostManager');

/**
 * A query past its bound (R5(a)): refused alone and typed, with its cancel sent. The host keeps
 * running; the request channel releases the query without stopping it.
 */
export function queryEmbeddingTimeout(
  context: HostRequestTimeoutContext,
  cancel: () => void
): HostRequestTimeoutDecision {
  logger.warn('Embedding host query timed out', {
    elapsedMs: Math.max(0, context.timedOutAt - context.startedAt),
    pendingCount: context.pendingCount,
    provider: 'local',
    stage: 'host-response',
    timeoutMs: context.timeoutMs,
  });
  let error: Error = new BoundaryFailureError(
    refusal({
      category: 'timeout',
      code: 'embedding-host.query-timeout',
      message: `The embedding model did not answer this search within ${Math.round(context.timeoutMs / 1000)} s, so the search was cancelled.`,
      remedy: 'Search again.',
    }),
    { cause: new Error(`Embedding host request ${context.requestId} timed out.`) }
  );
  try {
    cancel();
  } catch (deliveryError) {
    error = new AggregateError(
      [error, deliveryError],
      'Query embedding timeout cancellation failed.'
    );
  }
  return { error, policy: 'abandon' };
}

/**
 * A document batch's liveness window expired. The log keeps the request identity; the error is
 * the plain-language unresponsive-host refusal that blocks indexing until Retry (BST-2104).
 */
export function documentBatchTimeout(
  request: EmbeddingHostDocumentEmbeddingsRequest,
  context: HostRequestTimeoutContext,
  lastProgress: EmbeddingRequestProgress | undefined,
  cancel: () => void
): HostRequestTimeoutDecision {
  const elapsedMs = Math.max(0, context.timedOutAt - context.startedAt);
  const texts = request.payload.texts.length;
  logger.warn('Embedding host document batch timed out', {
    elapsedMs,
    pendingCount: context.pendingCount,
    progressCount: context.progressCount,
    provider: 'local',
    requestId: context.requestId,
    stage: embeddingHostUnresponsiveStage(lastProgress),
    texts,
    timeoutMs: context.timeoutMs,
    ...(lastProgress?.stage === 'inference' ? { completed: lastProgress.completed } : {}),
  });
  let error: Error = embeddingHostUnresponsiveError({
    elapsedMs,
    lastProgress,
    texts,
    windowMs: context.timeoutMs,
  });
  try {
    cancel();
  } catch (deliveryError) {
    error = new AggregateError(
      [error, deliveryError],
      'Document embedding timeout cancellation failed.'
    );
  }
  return { error, policy: 'abandon' };
}
