// @vitest-environment jsdom
import './embedding-host-runtime-fixture';
import type { EmbeddingResult } from '@brainstrike/embeddings';
import { act } from '@brainstrike/test-utils/react-act';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  createEmbeddingHostDocumentEmbeddingsRequest,
  createEmbeddingHostQueryEmbeddingRequest,
} from '../../../embedding-host-shared';
import { EmbeddingHostRuntime } from '../../../renderer/components/embedding-host-runtime';
import {
  documentEmbeddingsListenerRef,
  generateDocumentEmbeddingsMock,
  generateQueryEmbeddingMock,
  installEmbeddingHostRuntimeFixture,
  queryEmbeddingListenerRef,
  reportDocumentEmbeddingsResponseMock,
  reportQueryEmbeddingResponseMock,
  storeState,
} from './embedding-host-runtime-fixture';

const plan = {
  device: 'wasm' as const,
  dimensions: 384 as const,
  dtype: 'q8' as const,
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
};

function vector(value: number): EmbeddingResult {
  return {
    dimensions: 384,
    embedding: Array.from({ length: 384 }, () => value),
    model: plan.modelId,
    runtime: {
      device: plan.device,
      dtype: plan.dtype,
      fallbackApplied: false,
      pooling: 'mean',
      revision: plan.revision,
    },
  };
}

const TEXTS = ['document zero', 'document one', 'document two'];

function isReport(type: string) {
  return ([report]: unknown[]) =>
    typeof report === 'object' && report !== null && Reflect.get(report, 'type') === type;
}

describe('hidden host inference turns', () => {
  installEmbeddingHostRuntimeFixture();

  it('answers a search enqueued during a document batch before the batch’s remaining slices', async () => {
    // Each document inference call stays pending until the test settles it, so the batch
    // is observably in flight; every text gets a value derived from its batch position.
    const calls: { readonly texts: readonly string[]; readonly settle: () => void }[] = [];
    generateDocumentEmbeddingsMock.mockImplementation(async (...args: unknown[]) => {
      const texts = args[0] as readonly string[];
      const settled = Promise.withResolvers<void>();
      calls.push({ settle: settled.resolve, texts });
      await settled.promise;
      return texts.map((text) => vector(TEXTS.indexOf(text) + 1));
    });
    generateQueryEmbeddingMock.mockImplementation(async () => vector(9));
    // What had happened to the batch at the moment the search was answered.
    const atSearchAnswer: { slicesStarted: number; batchAnswered: boolean }[] = [];
    reportQueryEmbeddingResponseMock.mockImplementation(() => {
      atSearchAnswer.push({
        batchAnswered: reportDocumentEmbeddingsResponseMock.mock.calls.some(isReport('result')),
        slicesStarted: calls.length,
      });
    });
    storeState.hasHydrated = true;
    render(<EmbeddingHostRuntime />);
    await waitFor(() => expect(documentEmbeddingsListenerRef.current).toBeTypeOf('function'));

    const batch = createEmbeddingHostDocumentEmbeddingsRequest('test-runtime', {
      dimensions: 384,
      inferencePlan: plan,
      modelId: plan.modelId,
      modelKey: 'native:documents',
      texts: [...TEXTS],
    });
    await act(async () => documentEmbeddingsListenerRef.current?.(batch));
    await waitFor(() => expect(calls).toHaveLength(1));

    const search = createEmbeddingHostQueryEmbeddingRequest('test-runtime', {
      dimensions: 384,
      inferencePlan: plan,
      modelId: plan.modelId,
      modelKey: 'native:documents',
      query: 'search during indexing',
    });
    await act(async () => queryEmbeddingListenerRef.current?.(search));
    calls[0]?.settle();

    await waitFor(() =>
      expect(reportQueryEmbeddingResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: search.requestId, type: 'result' })
      )
    );
    // The search ran in the batch's next turn: no later slice had started and the batch was unanswered.
    expect(atSearchAnswer).toEqual([{ batchAnswered: false, slicesStarted: 1 }]);

    for (let settled = 1; settled < TEXTS.length; settled += 1) {
      await waitFor(() => expect(calls).toHaveLength(settled + 1));
      calls[settled]?.settle();
    }
    await waitFor(() =>
      expect(reportDocumentEmbeddingsResponseMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { embeddings: TEXTS.map((_text, index) => vector(index + 1).embedding) },
          requestId: batch.requestId,
          type: 'result',
        })
      )
    );
  });
});
