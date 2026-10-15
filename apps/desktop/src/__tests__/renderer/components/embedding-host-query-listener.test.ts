// @vitest-environment jsdom
import './embedding-host-foreground-ownership-fixture';
import type { EmbeddingResult } from '@brainstrike/embeddings';
import { waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createEmbeddingHostQueryEmbeddingCancel,
  createEmbeddingHostQueryEmbeddingRequest,
  EMBEDDING_HOST_QUERY_CANCELED_CODE,
} from '../../../embedding-host-shared';
import {
  type AdmittedQueryEmbeddingRequest,
  subscribeQueryEmbeddingRequests,
} from '../../../renderer/components/embedding-host-query-listener';
import {
  closeQueryEmbeddingRuntimeOwner,
  createQueryEmbeddingRuntimeOwner,
  runOwnedQueryEmbeddingInference,
} from '../../../renderer/components/embedding-host-query-owner';
import {
  installEmbeddingHostRuntimeFixture,
  queryEmbeddingCancelListenerRef,
  queryEmbeddingListenerRef,
  readModelCatalogMock,
  reportQueryEmbeddingResponseMock,
} from './embedding-host-foreground-ownership-fixture';

const payload = { dimensions: 2, modelId: 'model-a', modelKey: 'local:model-a', query: 'fixture' };

describe('embedding query listener request ownership', () => {
  installEmbeddingHostRuntimeFixture();

  it('retains canceled request identity until FIFO settlement and releases both entries afterward', async () => {
    const owner = createQueryEmbeddingRuntimeOwner({ read: readModelCatalogMock });
    const held = Promise.withResolvers<void>();
    const handle = vi.fn(async (_request: AdmittedQueryEmbeddingRequest) => {
      await held.promise;
    });
    const unsubscribe = subscribeQueryEmbeddingRequests({
      handle,
      isStopping: () => false,
      ownerRef: { current: owner },
      runtimeIdRef: { current: 'runtime-a' },
    });
    onTestFinished(() => {
      held.resolve();
      unsubscribe();
    });
    const head = createEmbeddingHostQueryEmbeddingRequest('runtime-a', payload);
    const queued = createEmbeddingHostQueryEmbeddingRequest('runtime-a', payload);
    queryEmbeddingListenerRef.current?.(head);
    queryEmbeddingListenerRef.current?.(queued);
    await waitFor(() => expect(handle).toHaveBeenCalledOnce());
    expect(owner.requests.size).toBe(2);
    const controller = owner.requests.get(queued.requestId);
    queryEmbeddingCancelListenerRef.current?.(createEmbeddingHostQueryEmbeddingCancel(queued));
    expect(controller?.signal.aborted).toBe(true);
    expect(owner.requests.get(queued.requestId)).toBe(controller);
    expect(owner.requests.get(head.requestId)?.signal.aborted).toBe(false);
    const reason: unknown = controller?.signal.reason;
    expect(reason).toMatchObject({ code: EMBEDDING_HOST_QUERY_CANCELED_CODE });
    queryEmbeddingCancelListenerRef.current?.(createEmbeddingHostQueryEmbeddingCancel(queued));
    expect(controller?.signal.reason).toBe(reason);
    held.resolve();
    await owner.executionTailRef.current;
    expect(handle).toHaveBeenCalledOnce();
    expect(owner.requests.size).toBe(0);
    expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ code: EMBEDDING_HOST_QUERY_CANCELED_CODE }),
        requestId: queued.requestId,
        type: 'error',
      })
    );
    unsubscribe();
    expect(queryEmbeddingListenerRef.current).toBeNull();
    expect(queryEmbeddingCancelListenerRef.current).toBeNull();
  });

  it('joins physical retirement and retains queued cancellation after the generation closes', async () => {
    const owner = createQueryEmbeddingRuntimeOwner({ read: readModelCatalogMock });
    const fifo = Promise.withResolvers<void>();
    const physical = Promise.withResolvers<void>();
    owner.executionTailRef.current = fifo.promise;
    const handle = vi.fn(async () => {});
    const unsubscribe = subscribeQueryEmbeddingRequests({
      handle,
      isStopping: () => false,
      ownerRef: { current: owner },
      runtimeIdRef: { current: 'runtime-a' },
    });
    const queued = createEmbeddingHostQueryEmbeddingRequest('runtime-a', payload);
    queryEmbeddingListenerRef.current?.(queued);
    queryEmbeddingCancelListenerRef.current?.(createEmbeddingHostQueryEmbeddingCancel(queued));
    const closing = closeQueryEmbeddingRuntimeOwner(owner, () => physical.promise, {
      current: 'runtime-a',
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
    expect(reportQueryEmbeddingResponseMock).not.toHaveBeenCalled();
    physical.resolve();
    await closing;
    await owner.executionTailRef.current;
    expect(handle).not.toHaveBeenCalled();
    expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ code: EMBEDDING_HOST_QUERY_CANCELED_CODE }),
        requestId: queued.requestId,
      })
    );
  });

  it('clears every admitted request on generation close while joining active inference settlement', async () => {
    const owner = createQueryEmbeddingRuntimeOwner({ read: readModelCatalogMock });
    const held = Promise.withResolvers<EmbeddingResult>();
    const handle = vi.fn(async (request: AdmittedQueryEmbeddingRequest) => {
      await runOwnedQueryEmbeddingInference(owner, () => held.promise, request.signal);
    });
    const unsubscribe = subscribeQueryEmbeddingRequests({
      handle,
      isStopping: () => false,
      ownerRef: { current: owner },
      runtimeIdRef: { current: 'runtime-a' },
    });
    onTestFinished(() => {
      held.resolve({ dimensions: 2, embedding: [1, 2], model: 'model-a' });
      unsubscribe();
    });
    queryEmbeddingListenerRef.current?.(
      createEmbeddingHostQueryEmbeddingRequest('runtime-a', payload)
    );
    queryEmbeddingListenerRef.current?.(
      createEmbeddingHostQueryEmbeddingRequest('runtime-a', payload)
    );
    await waitFor(() => expect(handle).toHaveBeenCalledOnce());
    const controllers = [...owner.requests.values()];
    let closed = false;
    const closing = closeQueryEmbeddingRuntimeOwner(owner, async () => {}, {
      current: 'runtime-a',
    }).then(() => {
      closed = true;
    });
    expect(owner.requests.size).toBe(0);
    expect(controllers).toHaveLength(2);
    expect(controllers.every((controller) => controller.signal.aborted)).toBe(true);
    expect(closed).toBe(false);
    held.resolve({ dimensions: 2, embedding: [1, 2], model: 'model-a' });
    await closing;
    await owner.executionTailRef.current;
    expect(closed).toBe(true);
    expect(handle).toHaveBeenCalledOnce();
    expect(owner.requests.size).toBe(0);
  });
});
