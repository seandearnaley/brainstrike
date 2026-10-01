import './embedding-host-foreground-ownership-fixture';
import type { EmbeddingResult } from '@brainstrike/embeddings';
import { waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createEmbeddingHostQueryEmbeddingCancel,
  createEmbeddingHostQueryEmbeddingRequest,
} from '../../../embedding-host-shared';
import {
  type AdmittedQueryEmbeddingRequest,
  subscribeQueryEmbeddingRequests,
} from '../../../renderer/components/embedding-host-query-listener';
import {
  closeQueryEmbeddingRuntimeOwner,
  createQueryEmbeddingRuntimeOwner,
  type QueryEmbeddingRuntimeOwner,
  runOwnedQueryEmbeddingInference,
} from '../../../renderer/components/embedding-host-query-owner';
import {
  dbHandle,
  installEmbeddingHostRuntimeFixture,
  queryEmbeddingCancelListenerRef,
  queryEmbeddingListenerRef,
  reportQueryEmbeddingResponseMock,
} from './embedding-host-foreground-ownership-fixture';

const payload = { dimensions: 2, modelId: 'model-a', modelKey: 'local:model-a', query: 'fixture' };

describe('embedding query listener request ownership', () => {
  installEmbeddingHostRuntimeFixture();

  it('retains canceled request identity until FIFO settlement and releases both entries afterward', async () => {
    const owner = createQueryEmbeddingRuntimeOwner(
      dbHandle as unknown as QueryEmbeddingRuntimeOwner['db']
    );
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
    queryEmbeddingCancelListenerRef.current?.(createEmbeddingHostQueryEmbeddingCancel(queued));
    expect(controller?.signal.reason).toBe(reason);
    held.resolve();
    await owner.executionTailRef.current;
    expect(handle).toHaveBeenCalledOnce();
    expect(owner.requests.size).toBe(0);
    expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: queued.requestId, type: 'error' })
    );
    unsubscribe();
    expect(queryEmbeddingListenerRef.current).toBeNull();
    expect(queryEmbeddingCancelListenerRef.current).toBeNull();
  });

  it('clears every admitted request on generation close while joining active inference settlement', async () => {
    const owner = createQueryEmbeddingRuntimeOwner(
      dbHandle as unknown as QueryEmbeddingRuntimeOwner['db']
    );
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
    const closing = closeQueryEmbeddingRuntimeOwner(owner).then(() => {
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
