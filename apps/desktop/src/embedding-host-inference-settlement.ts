import { deserializeRuntimeError } from '@brainstrike/worker-runtime';
import {
  EMBEDDING_HOST_DOCUMENT_CANCELED_CODE,
  EMBEDDING_HOST_QUERY_CANCELED_CODE,
  EMBEDDING_HOST_RUNTIME_STOPPED_CODE,
  type EmbeddingHostDocumentEmbeddingsPayload,
  type EmbeddingHostDocumentEmbeddingsRequest,
  type EmbeddingHostDocumentEmbeddingsResponseReport,
  type EmbeddingHostQueryEmbeddingRequest,
  type EmbeddingHostQueryEmbeddingResponseReport,
} from './embedding-host-shared';
import type { HostRequestInterruptionContext } from './platform/host-request-channel';

export function documentResponseFailure(
  payload: EmbeddingHostDocumentEmbeddingsPayload,
  report: EmbeddingHostDocumentEmbeddingsResponseReport
): Error | null {
  if (report.type === 'error') {
    return deserializeRuntimeError(report.payload);
  }
  if (report.type === 'progress') {
    // The request channel consumes progress as liveness; it can never settle a batch.
    return new Error('Document embedding progress cannot settle its request.');
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

export function queryResponseFailure(
  request: EmbeddingHostQueryEmbeddingRequest,
  report: EmbeddingHostQueryEmbeddingResponseReport
): Error | null {
  if (report.type === 'error') {
    return deserializeRuntimeError(report.payload);
  }
  if (
    report.payload.embedding.length !== request.payload.dimensions ||
    !report.payload.embedding.every(Number.isFinite)
  ) {
    return new Error('Query embedding response dimensions do not match request.');
  }
  return null;
}

export function joinDocumentEmbeddingInterruption(
  request: EmbeddingHostDocumentEmbeddingsRequest,
  context: HostRequestInterruptionContext<EmbeddingHostDocumentEmbeddingsResponseReport>,
  retire: () => Promise<unknown>,
  timeoutMs: number
): Promise<unknown> {
  return joinEmbeddingInterruption(context, retire, timeoutMs, {
    cancellationCode: EMBEDDING_HOST_DOCUMENT_CANCELED_CODE,
    failure: (report) => documentResponseFailure(request.payload, report),
    label: 'Document embedding',
  });
}

export function joinQueryEmbeddingInterruption(
  request: EmbeddingHostQueryEmbeddingRequest,
  context: HostRequestInterruptionContext<EmbeddingHostQueryEmbeddingResponseReport>,
  retire: () => Promise<unknown>,
  timeoutMs: number
): Promise<unknown> {
  return joinEmbeddingInterruption(context, retire, timeoutMs, {
    cancellationCode: EMBEDDING_HOST_QUERY_CANCELED_CODE,
    failure: (report) => queryResponseFailure(request, report),
    label: 'Query embedding',
  });
}

/** Join interruption through a terminal response or the manager-owned retirement. */
async function joinEmbeddingInterruption<Response>(
  context: HostRequestInterruptionContext<Response>,
  retire: () => Promise<unknown>,
  timeoutMs: number,
  response: {
    readonly cancellationCode: string;
    readonly failure: (report: Response) => Error | null;
    readonly label: string;
  }
): Promise<unknown> {
  // The exact cancel, or a host Stop that ended the request: both answer only after the
  // physical join. Shutdown and the Stop escalation below both retire the host this way.
  const isCancellation = (error: Error): boolean => {
    const code = (error as Error & { code?: unknown }).code;
    return code === response.cancellationCode || code === EMBEDDING_HOST_RUNTIME_STOPPED_CODE;
  };
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
            `${response.label} host retired during cancellation.`
          )
        : context.error;
    }
    if (settlement?.type === 'response') {
      const error = response.failure(settlement.response);
      if (error && !isCancellation(error)) {
        return new AggregateError(
          [context.error, error],
          `${response.label} failed during cancellation.`
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
      const error = response.failure(settlement.response);
      if (error && !isCancellation(error)) {
        completionFailure = error;
      }
    }
  });
  try {
    await retire();
    return completionFailure
      ? new AggregateError(
          [context.error, completionFailure],
          `${response.label} failed during retirement.`
        )
      : context.error;
  } catch (error) {
    // stopHost rejects only after the failed cooperative stop's window has retired.
    return new AggregateError(
      completionFailure && completionFailure !== error
        ? [context.error, completionFailure, error]
        : [context.error, error],
      `${response.label} interruption required failed host retirement.`
    );
  }
}
