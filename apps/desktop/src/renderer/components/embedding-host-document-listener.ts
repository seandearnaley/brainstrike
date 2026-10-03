import { createLogger } from '@brainstrike/logging';
import type { MutableRefObject } from 'react';
import {
  assertEmbeddingHostDocumentEmbeddingsCancel,
  assertEmbeddingHostDocumentEmbeddingsRequest,
  createEmbeddingHostDocumentCancellationError,
  createEmbeddingHostDocumentEmbeddingsErrorReport,
  type EmbeddingHostDocumentEmbeddingsRequest,
} from '../../embedding-host-shared';
import { getEmbeddingHostBridge, reportDocumentEmbeddingsResponse } from './embedding-host-bridge';
import {
  createDocumentEmbeddingsRequestParseErrorReport,
  runEmbeddingHostCleanupStep,
} from './embedding-host-lifecycle';
import {
  enqueueQueryEmbeddingOperation,
  type QueryEmbeddingRuntimeOwner,
} from './embedding-host-query-owner';

const logger = createLogger('EmbeddingHostRuntime');

export interface AdmittedDocumentEmbeddingsRequest {
  readonly isCurrent: () => boolean;
  readonly queryOwner: QueryEmbeddingRuntimeOwner;
  readonly request: EmbeddingHostDocumentEmbeddingsRequest;
  readonly signal: AbortSignal;
}

/** Mounted-host subscriptions admit requests before FIFO work and bind cancellation to their exact generation. */
export function subscribeDocumentEmbeddingsRequests(options: {
  readonly ownerRef: MutableRefObject<QueryEmbeddingRuntimeOwner | null>;
  readonly runtimeIdRef: MutableRefObject<string>;
  readonly isStopping: () => boolean;
  readonly handle: (request: AdmittedDocumentEmbeddingsRequest) => Promise<void>;
}): () => void {
  const bridge = getEmbeddingHostBridge();
  const unsubscribeRequest = bridge?.onDocumentEmbeddingsRequest?.((rawRequest) => {
    let request: EmbeddingHostDocumentEmbeddingsRequest;
    try {
      request = assertEmbeddingHostDocumentEmbeddingsRequest(rawRequest);
    } catch (error) {
      const response = createDocumentEmbeddingsRequestParseErrorReport(rawRequest, error);
      logger.error('Rejected invalid embedding host document embeddings request', {
        error,
        requestId: response?.requestId ?? null,
        runtimeId: response?.runtimeId ?? null,
      });
      if (response?.type === 'error') {
        reportDocumentEmbeddingsResponse(response);
      }
      return;
    }
    if (typeof bridge?.onDocumentEmbeddingsCancel !== 'function') {
      reportDocumentEmbeddingsResponse(
        createEmbeddingHostDocumentEmbeddingsErrorReport(
          request,
          new Error('Embedding host document cancellation capability is unavailable.')
        )
      );
      return;
    }
    const queryOwner = options.ownerRef.current;
    if (
      !queryOwner ||
      queryOwner.closed ||
      options.isStopping() ||
      request.runtimeId !== options.runtimeIdRef.current
    ) {
      reportDocumentEmbeddingsResponse(
        createEmbeddingHostDocumentEmbeddingsErrorReport(
          request,
          new Error('Embedding host document runtime is unavailable.')
        )
      );
      return;
    }
    if (queryOwner.requests.has(request.requestId)) {
      reportDocumentEmbeddingsResponse(
        createEmbeddingHostDocumentEmbeddingsErrorReport(
          request,
          new Error('Embedding host document request is already in flight.')
        )
      );
      return;
    }
    const controller = new AbortController();
    queryOwner.requests.set(request.requestId, controller);
    const isCurrent = (): boolean =>
      options.ownerRef.current === queryOwner &&
      !queryOwner.closed &&
      !options.isStopping() &&
      request.runtimeId === options.runtimeIdRef.current;
    void enqueueQueryEmbeddingOperation(queryOwner, async () => {
      try {
        if (!isCurrent()) {
          throw new Error('Embedding host document runtime is no longer available.');
        }
        controller.signal.throwIfAborted();
        await options.handle({ isCurrent, queryOwner, request, signal: controller.signal });
      } catch (error) {
        reportDocumentEmbeddingsResponse(
          createEmbeddingHostDocumentEmbeddingsErrorReport(request, error)
        );
      } finally {
        if (queryOwner.requests.get(request.requestId) === controller) {
          queryOwner.requests.delete(request.requestId);
        }
      }
    }).catch((error: unknown) => {
      logger.error('Unhandled embedding host document embeddings request failure', {
        error,
        requestId: request.requestId,
      });
    });
  });
  const unsubscribeCancel = bridge?.onDocumentEmbeddingsCancel?.((rawNotice) => {
    try {
      const notice = assertEmbeddingHostDocumentEmbeddingsCancel(rawNotice);
      const owner = options.ownerRef.current;
      if (
        !owner ||
        owner.closed ||
        options.isStopping() ||
        notice.runtimeId !== options.runtimeIdRef.current
      ) {
        return;
      }
      owner.requests.get(notice.requestId)?.abort(createEmbeddingHostDocumentCancellationError());
    } catch (error) {
      logger.error('Rejected invalid embedding host document cancellation', { error });
    }
  });
  return () => {
    runEmbeddingHostCleanupStep(
      options.runtimeIdRef,
      'Embedding host query embedding cleanup failed',
      () => unsubscribeRequest?.()
    );
    runEmbeddingHostCleanupStep(
      options.runtimeIdRef,
      'Embedding host query embedding cleanup failed',
      () => unsubscribeCancel?.()
    );
  };
}
