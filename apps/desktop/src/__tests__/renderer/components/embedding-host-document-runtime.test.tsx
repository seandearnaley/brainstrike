import './embedding-host-runtime-fixture';
import type { EmbeddingResult } from '@brainstrike/embeddings';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  createEmbeddingHostCommand,
  createEmbeddingHostDocumentEmbeddingsCancel,
  createEmbeddingHostDocumentEmbeddingsRequest,
} from '../../../embedding-host-shared';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';
import {
  commandListenerRef,
  dbHandle,
  documentEmbeddingsCancelListenerRef,
  documentEmbeddingsListenerRef,
  generateDocumentEmbeddingsMock,
  generateQueryEmbeddingMock,
  initializeMock,
  initializeWithModelMock,
  installEmbeddingHostRuntimeFixture,
  reportDocumentEmbeddingsResponseMock,
  reportStatusMock,
  retireEmbeddingQueueMock,
  storeState,
} from './embedding-host-runtime-fixture';

const plan = {
  device: 'wasm' as const,
  dimensions: 384 as const,
  dtype: 'q8' as const,
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
};
function results(): EmbeddingResult[] {
  return [0.1, 0.2].map((value) => ({
    dimensions: 384,
    embedding: Array.from({ length: 384 }, () => value),
    model: plan.modelId,
    runtime: {
      device: plan.device,
      dtype: plan.dtype,
      fallbackApplied: false,
      pooling: 'mean' as const,
      revision: plan.revision,
    },
  }));
}
function request() {
  return createEmbeddingHostDocumentEmbeddingsRequest('test-runtime', {
    dimensions: 384,
    inferencePlan: plan,
    modelId: plan.modelId,
    modelKey: 'native:documents',
    texts: ['  document one\n', 'document two'],
  });
}
// BST-1993: the granite catalog plan Main resolves, CLS pooling included.
const granitePlan = {
  device: 'webgpu' as const,
  dimensions: 384 as const,
  dtype: 'fp16' as const,
  modelId: 'onnx-community/granite-embedding-small-english-r2-ONNX',
  pooling: 'cls' as const,
  revision: '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8',
};
function graniteResults(pooling: 'mean' | 'cls'): EmbeddingResult[] {
  return [0.1, 0.2].map((value) => ({
    dimensions: 384,
    embedding: Array.from({ length: 384 }, () => value),
    model: granitePlan.modelId,
    runtime: {
      device: granitePlan.device,
      dtype: granitePlan.dtype,
      fallbackApplied: false,
      pooling,
      revision: granitePlan.revision,
    },
  }));
}
function graniteRequest() {
  return createEmbeddingHostDocumentEmbeddingsRequest('test-runtime', {
    dimensions: 384,
    inferencePlan: granitePlan,
    modelId: granitePlan.modelId,
    modelKey: 'local::onnx-community/granite-embedding-small-english-r2-ONNX',
    texts: ['  document one\n', 'document two'],
  });
}
async function mount() {
  storeState.hasHydrated = true;
  const view = render(<EmbeddingHostRuntime />);
  await waitFor(() => expect(documentEmbeddingsListenerRef.current).toBeTypeOf('function'));
  return view;
}
describe('hidden pinned document batch', () => {
  installEmbeddingHostRuntimeFixture();
  it('runs document semantics once, retains order and pins without catalog resolution', async () => {
    generateDocumentEmbeddingsMock.mockResolvedValue(results());
    await mount();
    const next = request();
    await act(async () => documentEmbeddingsListenerRef.current?.(next));
    await waitFor(() =>
      expect(reportDocumentEmbeddingsResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { embeddings: results().map((result) => result.embedding) },
          type: 'result',
        })
      )
    );
    expect(generateDocumentEmbeddingsMock).toHaveBeenCalledExactlyOnceWith(next.payload.texts, {
      signal: expect.any(AbortSignal),
    });
    expect(generateQueryEmbeddingMock).not.toHaveBeenCalled();
    expect(dbHandle.query).not.toHaveBeenCalled();
    expect(initializeWithModelMock).not.toHaveBeenCalled();
    expect(initializeMock).toHaveBeenCalledWith(expect.objectContaining(plan));
  });
  it('requests CLS pooling for the granite profile and keeps mean the default elsewhere (BST-1993)', async () => {
    generateDocumentEmbeddingsMock
      .mockResolvedValueOnce(results())
      .mockResolvedValueOnce(graniteResults('cls'));
    await mount();
    await act(async () => documentEmbeddingsListenerRef.current?.(request()));
    await waitFor(() => expect(reportDocumentEmbeddingsResponseMock).toHaveBeenCalledOnce());
    expect(initializeMock).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ pooling: 'cls' })
    );
    await act(async () => documentEmbeddingsListenerRef.current?.(graniteRequest()));
    await waitFor(() => expect(reportDocumentEmbeddingsResponseMock).toHaveBeenCalledTimes(2));
    expect(initializeMock).toHaveBeenLastCalledWith(expect.objectContaining(granitePlan));
    expect(reportDocumentEmbeddingsResponseMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'result' })
    );
  });
  it('refuses a granite batch whose worker did not apply CLS pooling (BST-1993)', async () => {
    generateDocumentEmbeddingsMock.mockResolvedValue(graniteResults('mean'));
    await mount();
    await act(async () => documentEmbeddingsListenerRef.current?.(graniteRequest()));
    await waitFor(() =>
      expect(reportDocumentEmbeddingsResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' })
      )
    );
    expect(reportDocumentEmbeddingsResponseMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'result' })
    );
  });
  it('retains the document response until physical pool retirement after execution rejects', async () => {
    const execution = Promise.withResolvers<EmbeddingResult[]>();
    const physical = Promise.withResolvers<void>();
    onTestFinished(() => {
      physical.resolve();
      execution.resolve(results());
    });
    generateDocumentEmbeddingsMock.mockReturnValueOnce(execution.promise);
    retireEmbeddingQueueMock.mockImplementationOnce(() => {
      execution.reject(new Error('Worker terminated'));
      return physical.promise;
    });
    await mount();
    await act(async () => documentEmbeddingsListenerRef.current?.(request()));
    await waitFor(() => expect(generateDocumentEmbeddingsMock).toHaveBeenCalledOnce());
    await act(async () =>
      commandListenerRef.current?.(createEmbeddingHostCommand('stop', 'test-runtime'))
    );
    expect(retireEmbeddingQueueMock).toHaveBeenCalledOnce();
    expect(reportDocumentEmbeddingsResponseMock).not.toHaveBeenCalled();
    expect(reportStatusMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'stopped' })
    );
    physical.resolve();
    await waitFor(() => expect(reportDocumentEmbeddingsResponseMock).toHaveBeenCalledOnce());
    expect(reportDocumentEmbeddingsResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ message: 'Worker terminated' }),
        type: 'error',
      })
    );
    await waitFor(() =>
      expect(reportStatusMock).toHaveBeenCalledWith(expect.objectContaining({ state: 'stopped' }))
    );
  });

  it.each([
    'revision',
    'device',
    'dtype',
    'fallback',
    'count',
    'model',
    'dimensions',
    'nonfinite',
  ] as const)('refuses malformed batch %s before any success', async (invalid) => {
    const batch = results();
    const second = batch[1];
    if (!second?.runtime) {
      throw new Error('Missing fixture result');
    }
    if (invalid === 'revision') {
      second.runtime = { ...second.runtime, revision: 'main' };
    }
    if (invalid === 'device') {
      second.runtime = { ...second.runtime, device: 'webgpu' };
    }
    if (invalid === 'dtype') {
      second.runtime = { ...second.runtime, dtype: 'fp32' };
    }
    if (invalid === 'fallback') {
      second.runtime = { ...second.runtime, fallbackApplied: true };
    }
    if (invalid === 'count') {
      batch.pop();
    }
    if (invalid === 'model') {
      second.model = 'other';
    }
    if (invalid === 'dimensions') {
      second.embedding.pop();
    }
    if (invalid === 'nonfinite') {
      second.embedding[0] = Number.NaN;
    }
    generateDocumentEmbeddingsMock.mockResolvedValue(batch);
    await mount();
    await act(async () => documentEmbeddingsListenerRef.current?.(request()));
    await waitFor(() =>
      expect(reportDocumentEmbeddingsResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' })
      )
    );
    expect(reportDocumentEmbeddingsResponseMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'result' })
    );
  });
  it('an active cancel fences only its request while physical settlement serializes the next batch', async () => {
    const pending = Promise.withResolvers<EmbeddingResult[]>();
    generateDocumentEmbeddingsMock
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(results());
    await mount();
    const first = request();
    const second = request();
    await act(async () => {
      documentEmbeddingsListenerRef.current?.(first);
      documentEmbeddingsListenerRef.current?.(second);
    });
    await waitFor(() => expect(generateDocumentEmbeddingsMock).toHaveBeenCalledOnce());
    const options = generateDocumentEmbeddingsMock.mock.calls[0]?.[1] as { signal: AbortSignal };
    await act(async () =>
      documentEmbeddingsCancelListenerRef.current?.({
        ...createEmbeddingHostDocumentEmbeddingsCancel(first),
        runtimeId: 'other-runtime',
      })
    );
    expect(options.signal.aborted).toBe(false);
    await act(async () =>
      documentEmbeddingsCancelListenerRef.current?.(
        createEmbeddingHostDocumentEmbeddingsCancel(first)
      )
    );
    expect(options.signal.aborted).toBe(true);
    expect(generateDocumentEmbeddingsMock).toHaveBeenCalledOnce();
    expect(reportDocumentEmbeddingsResponseMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: first.requestId })
    );
    pending.resolve(results());
    await waitFor(() => expect(generateDocumentEmbeddingsMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(reportDocumentEmbeddingsResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: second.requestId, type: 'result' })
      )
    );
    expect(reportDocumentEmbeddingsResponseMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: first.requestId, type: 'result' })
    );
    expect(reportDocumentEmbeddingsResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ code: 'EMBEDDING_HOST_DOCUMENT_CANCELED' }),
        requestId: first.requestId,
        type: 'error',
      })
    );
  });
  it('cancels queued documents before preparation and retains active ownership until settlement and Stop', async () => {
    const pending = Promise.withResolvers<EmbeddingResult[]>();
    generateDocumentEmbeddingsMock.mockReturnValueOnce(pending.promise);
    await mount();
    const first = request();
    const queued = request();
    await act(async () => {
      documentEmbeddingsListenerRef.current?.(first);
      documentEmbeddingsListenerRef.current?.(queued);
    });
    await waitFor(() => expect(generateDocumentEmbeddingsMock).toHaveBeenCalledOnce());
    await act(async () =>
      documentEmbeddingsCancelListenerRef.current?.(
        createEmbeddingHostDocumentEmbeddingsCancel(queued)
      )
    );
    expect(generateDocumentEmbeddingsMock).toHaveBeenCalledOnce();
    const signal = generateDocumentEmbeddingsMock.mock.calls[0]?.[1] as { signal: AbortSignal };
    await act(async () =>
      commandListenerRef.current?.(createEmbeddingHostCommand('stop', 'test-runtime'))
    );
    expect(signal.signal.aborted).toBe(true);
    expect(reportStatusMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'stopped' })
    );
    pending.resolve(results());
    await waitFor(() =>
      expect(reportStatusMock).toHaveBeenCalledWith(expect.objectContaining({ state: 'stopped' }))
    );
    expect(generateDocumentEmbeddingsMock).toHaveBeenCalledOnce();
    expect(reportDocumentEmbeddingsResponseMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'result' })
    );
  });
});
