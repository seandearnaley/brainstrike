import { createLogger } from '@brainstrike/logging';
import type { MutableRefObject } from 'react';
import {
  assertEmbeddingHostQueryEmbeddingCancel,
  assertEmbeddingHostQueryEmbeddingRequest,
  createEmbeddingHostQueryEmbeddingErrorReport,
  type EmbeddingHostQueryEmbeddingRequest,
} from '../../embedding-host-shared';
import { getEmbeddingHostBridge, reportQueryEmbeddingResponse } from './embedding-host-bridge';
import {
  createQueryEmbeddingRequestParseErrorReport,
  runEmbeddingHostCleanupStep,
} from './embedding-host-lifecycle';
import {
  enqueueQueryEmbeddingOperation,
  type QueryEmbeddingRuntimeOwner,
} from './embedding-host-query-owner';

const logger = createLogger('EmbeddingHostRuntime');

export interface AdmittedQueryEmbeddingRequest {
  readonly isCurrent: () => boolean;
  readonly queryOwner: QueryEmbeddingRuntimeOwner;
  readonly request: EmbeddingHostQueryEmbeddingRequest;
  readonly signal: AbortSignal;
}

/** Mounted-host subscriptions admit requests before FIFO work and bind cancellation to their exact generation. */
export function subscribeQueryEmbeddingRequests(options: {
  readonly ownerRef: MutableRefObject<QueryEmbeddingRuntimeOwner | null>;
  readonly runtimeIdRef: MutableRefObject<string>;
  readonly isStopping: () => boolean;
  readonly handle: (request: AdmittedQueryEmbeddingRequest) => Promise<void>;
}): () => void {
  const bridge = getEmbeddingHostBridge();
  const unsubscribeRequest = bridge?.onQueryEmbeddingRequest?.((rawRequest) => {
    let request: EmbeddingHostQueryEmbeddingRequest;
    try {
      request = assertEmbeddingHostQueryEmbeddingRequest(rawRequest);
    } catch (error) {
      const response = createQueryEmbeddingRequestParseErrorReport(rawRequest, error);
      logger.error('Rejected invalid embedding host query embedding request', {
        error,
        requestId: response?.requestId ?? null,
        runtimeId: response?.runtimeId ?? null,
      });
      if (response) {
        reportQueryEmbeddingResponse(response);
      }
      return;
    }
    if (typeof bridge?.onQueryEmbeddingCancel !== 'function') {
      reportQueryEmbeddingResponse(
        createEmbeddingHostQueryEmbeddingErrorReport(
          request,
          new Error('Embedding host query cancellation capability is unavailable.')
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
      reportQueryEmbeddingResponse(
        createEmbeddingHostQueryEmbeddingErrorReport(
          request,
          new Error('Embedding host query runtime is unavailable.')
        )
      );
      return;
    }
    if (queryOwner.requests.has(request.requestId)) {
      reportQueryEmbeddingResponse(
        createEmbeddingHostQueryEmbeddingErrorReport(
          request,
          new Error('Embedding host query request is already in flight.')
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
          throw new Error('Embedding host query runtime is no longer available.');
        }
        controller.signal.throwIfAborted();
        await options.handle({ isCurrent, queryOwner, request, signal: controller.signal });
      } catch (error) {
        reportQueryEmbeddingResponse(createEmbeddingHostQueryEmbeddingErrorReport(request, error));
      } finally {
        if (queryOwner.requests.get(request.requestId) === controller) {
          queryOwner.requests.delete(request.requestId);
        }
      }
    }).catch((error: unknown) => {
      logger.error('Unhandled embedding host query embedding request failure', {
        error,
        requestId: request.requestId,
      });
    });
  });
  const unsubscribeCancel = bridge?.onQueryEmbeddingCancel?.((rawNotice) => {
    try {
      const notice = assertEmbeddingHostQueryEmbeddingCancel(rawNotice);
      const owner = options.ownerRef.current;
      if (
        !owner ||
        owner.closed ||
        options.isStopping() ||
        notice.runtimeId !== options.runtimeIdRef.current
      ) {
        return;
      }
      owner.requests
        .get(notice.requestId)
        ?.abort(new DOMException('Embedding host query request was canceled.', 'AbortError'));
    } catch (error) {
      logger.error('Rejected invalid embedding host query cancellation', { error });
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
