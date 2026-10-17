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
