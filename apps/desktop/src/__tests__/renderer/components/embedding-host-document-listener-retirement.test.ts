import './embedding-host-runtime-fixture';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createEmbeddingHostDocumentEmbeddingsCancel,
  createEmbeddingHostDocumentEmbeddingsRequest,
  EMBEDDING_HOST_DOCUMENT_CANCELED_CODE,
} from '../../../embedding-host-shared';
import { subscribeDocumentEmbeddingsRequests } from '../../../renderer/components/embedding-host-document-listener';
import {
  closeQueryEmbeddingRuntimeOwner,
  createQueryEmbeddingRuntimeOwner,
  type QueryEmbeddingRuntimeOwner,
} from '../../../renderer/components/embedding-host-query-owner';
import {
  dbHandle,
  documentEmbeddingsCancelListenerRef,
  documentEmbeddingsListenerRef,
  installEmbeddingHostRuntimeFixture,
  reportDocumentEmbeddingsResponseMock,
} from './embedding-host-runtime-fixture';

describe('document listener retirement', () => {
  installEmbeddingHostRuntimeFixture();
  it('joins physical retirement and retains queued cancellation after the generation closes', async () => {
    const owner = createQueryEmbeddingRuntimeOwner(
      dbHandle as unknown as QueryEmbeddingRuntimeOwner['db']
    );
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
    const queued = createEmbeddingHostDocumentEmbeddingsRequest('test-runtime', {
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
    documentEmbeddingsListenerRef.current?.(queued);
    documentEmbeddingsCancelListenerRef.current?.(
      createEmbeddingHostDocumentEmbeddingsCancel(queued)
    );
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
    expect(reportDocumentEmbeddingsResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ code: EMBEDDING_HOST_DOCUMENT_CANCELED_CODE }),
        requestId: queued.requestId,
      })
    );
  });
});
