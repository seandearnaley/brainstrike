// @vitest-environment jsdom
import './embedding-host-runtime-fixture';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createEmbeddingHostDocumentEmbeddingsCancel,
  createEmbeddingHostDocumentEmbeddingsRequest,
  EMBEDDING_HOST_DOCUMENT_CANCELED_CODE,
  EMBEDDING_HOST_RUNTIME_STOPPED_CODE,
} from '../../../embedding-host-shared';
import { subscribeDocumentEmbeddingsRequests } from '../../../renderer/components/embedding-host-document-listener';
import {
  closeQueryEmbeddingRuntimeOwner,
  createQueryEmbeddingRuntimeOwner,
} from '../../../renderer/components/embedding-host-query-owner';
import {
  documentEmbeddingsCancelListenerRef,
  documentEmbeddingsListenerRef,
  installEmbeddingHostRuntimeFixture,
  readModelCatalogMock,
  reportDocumentEmbeddingsResponseMock,
} from './embedding-host-runtime-fixture';

function documentRequest() {
  return createEmbeddingHostDocumentEmbeddingsRequest('test-runtime', {
    dimensions: 384,
    inferencePlan: {
      device: 'wasm',
      dimensions: 384,
      dtype: 'q8',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    },
    modelId: 'Xenova/all-MiniLM-L6-v2',
    modelKey: 'local:model',
    texts: ['fixture'],
  });
}

/** Queues one request behind a held FIFO, optionally cancels it, then closes its generation. */
async function closeWithQueuedRequest(cancel: boolean) {
  const owner = createQueryEmbeddingRuntimeOwner({ read: readModelCatalogMock });
  const fifo = Promise.withResolvers<void>();
  const physical = Promise.withResolvers<void>();
  owner.executionTailRef.current = fifo.promise;
  const handle = vi.fn(async () => {});
  const unsubscribe = subscribeDocumentEmbeddingsRequests({
    handle,
    isStopping: () => false,
    ownerRef: { current: owner },
    runtimeIdRef: { current: 'test-runtime' },
  });
  const queued = documentRequest();
  documentEmbeddingsListenerRef.current?.(queued);
  if (cancel) {
    documentEmbeddingsCancelListenerRef.current?.(
      createEmbeddingHostDocumentEmbeddingsCancel(queued)
    );
  }
  const closing = closeQueryEmbeddingRuntimeOwner(owner, () => physical.promise, {
    current: 'test-runtime',
  });
  onTestFinished(async () => {
    fifo.resolve();
    physical.resolve();
    await closing;
    unsubscribe();
  });
  fifo.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(reportDocumentEmbeddingsResponseMock).not.toHaveBeenCalled();
  physical.resolve();
  await closing;
  await owner.executionTailRef.current;
  expect(handle).not.toHaveBeenCalled();
  return queued;
}

describe('document listener retirement', () => {
  installEmbeddingHostRuntimeFixture();
  it('joins physical retirement and retains queued cancellation after the generation closes', async () => {
    const queued = await closeWithQueuedRequest(true);
    expect(reportDocumentEmbeddingsResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ code: EMBEDDING_HOST_DOCUMENT_CANCELED_CODE }),
        requestId: queued.requestId,
      })
    );
  });

  it('answers a request the Stop ended with the coded Stop reason, after the physical join', async () => {
    const queued = await closeWithQueuedRequest(false);
    expect(reportDocumentEmbeddingsResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ code: EMBEDDING_HOST_RUNTIME_STOPPED_CODE }),
        requestId: queued.requestId,
      })
    );
  });
});
