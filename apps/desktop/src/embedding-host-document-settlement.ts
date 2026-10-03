import { deserializeRuntimeError } from '@brainstrike/worker-runtime';
import {
  EMBEDDING_HOST_DOCUMENT_CANCELED_CODE,
  type EmbeddingHostDocumentEmbeddingsPayload,
  type EmbeddingHostDocumentEmbeddingsRequest,
  type EmbeddingHostDocumentEmbeddingsResponseReport,
} from './embedding-host-shared';
import type { HostRequestInterruptionContext } from './platform/host-request-channel';

export function documentResponseFailure(
  payload: EmbeddingHostDocumentEmbeddingsPayload,
  report: EmbeddingHostDocumentEmbeddingsResponseReport
): Error | null {
  if (report.type === 'error') {
    return deserializeRuntimeError(report.payload);
  }
  if (
    report.payload.embeddings.length !== payload.texts.length ||
    report.payload.embeddings.some(
      (vector) => vector.length !== payload.dimensions || !vector.every(Number.isFinite)
    )
  ) {
    return new Error('Document embedding response count or dimensions do not match request.');
  }
  return null;
}

function isDocumentCancellation(error: Error): boolean {
  return (error as Error & { code?: unknown }).code === EMBEDDING_HOST_DOCUMENT_CANCELED_CODE;
}

/** Join document interruption through a terminal response or the manager-owned retirement. */
export async function joinDocumentEmbeddingInterruption(
  request: EmbeddingHostDocumentEmbeddingsRequest,
  context: HostRequestInterruptionContext<EmbeddingHostDocumentEmbeddingsResponseReport>,
  retire: () => Promise<unknown>,
  timeoutMs: number
): Promise<unknown> {
  // Sending cancel is only a request. A terminal response is emitted after owned inference.
  // Give cooperative caller cancellation the existing Stop window, then retire through Stop.
  if (context.source === 'abort' && context.error === context.reason) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settlement = await Promise.race([
      context.settlement,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (settlement?.type === 'retired') {
      return settlement.error
        ? new AggregateError(
            [context.error, settlement.error],
            'Document embedding host retired during cancellation.'
          )
        : context.error;
    }
    if (settlement?.type === 'response') {
      const error = documentResponseFailure(request.payload, settlement.response);
      if (error && !isDocumentCancellation(error)) {
        return new AggregateError(
          [context.error, error],
          'Document embedding failed during cancellation.'
        );
      }
      return context.error;
    }
  }
  let completionFailure: Error | null = null;
  void context.settlement.then((settlement) => {
    if (settlement.type === 'retired') {
      completionFailure = settlement.error;
    } else {
      const error = documentResponseFailure(request.payload, settlement.response);
      if (error && !isDocumentCancellation(error)) {
        completionFailure = error;
      }
    }
  });
  try {
    await retire();
    return completionFailure
      ? new AggregateError(
          [context.error, completionFailure],
          'Document embedding failed during retirement.'
        )
      : context.error;
  } catch (error) {
    // stopHost rejects only after the failed cooperative stop's window has retired.
    return new AggregateError(
      completionFailure && completionFailure !== error
        ? [context.error, completionFailure, error]
        : [context.error, error],
      'Document embedding interruption required failed host retirement.'
    );
  }
}
