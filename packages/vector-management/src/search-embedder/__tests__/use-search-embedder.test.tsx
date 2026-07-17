import type { EmbeddingModelConfig } from '@brainstrike/indexing-contract';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingSetModelInfo } from '../use-search-embedder';
import { useSearchEmbedder } from '../use-search-embedder';

// Shared, persistent mocks. Wiring the service constructor once (instead of
// swapping mockImplementation per test) keeps each `new SimpleEmbeddingService()`
// pointed at the SAME generateQueryEmbedding fn, so a `mockRejectedValueOnce`
// device-loss error correctly carries across the retry's fresh instance.
const {
  MockSimpleEmbeddingService,
  mockGenerateDocEmbedding,
  mockGenerateQueryEmbedding,
  mockCreateProvider,
  mockDispose,
  mockEmbed,
  mockInitializeWithModel,
} = vi.hoisted(() => ({
  MockSimpleEmbeddingService: vi.fn(),
  mockCreateProvider: vi.fn(),
  mockDispose: vi.fn(),
  mockEmbed: vi.fn(),
  mockGenerateDocEmbedding: vi.fn(),
  mockGenerateQueryEmbedding: vi.fn(),
  mockInitializeWithModel: vi.fn(),
}));

vi.mock('@brainstrike/embeddings/factory', () => ({
  EmbeddingProviderFactory: { createProvider: mockCreateProvider },
}));

vi.mock('@brainstrike/embeddings/service', () => {
  MockSimpleEmbeddingService.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {
      dispose: mockDispose,
      generateDocEmbedding: mockGenerateDocEmbedding,
      generateQueryEmbedding: mockGenerateQueryEmbedding,
      initializeWithModel: mockInitializeWithModel,
    });
  });
  return { SimpleEmbeddingService: MockSimpleEmbeddingService };
});

const localModelConfig: EmbeddingModelConfig = {
  description: 'Code-optimized embeddings',
  dimensions: 1024,
  id: 'jinaai/jina-embeddings-v3',
  name: 'Jina Code',
  origin: 'transformers',
  quantized: false,
  tags: ['code'],
};

const hostedInfo: EmbeddingSetModelInfo = {
  dimensions: 1536,
  modelConfig: null,
  modelKey: 'openai::text-embedding-3-small',
};

const cohereInfo: EmbeddingSetModelInfo = {
  dimensions: 1024,
  modelConfig: null,
  modelKey: 'cohere::embed-english-v3.0',
};

const voyageInfo: EmbeddingSetModelInfo = {
  dimensions: 1024,
  modelConfig: null,
  modelKey: 'voyage::voyage-3',
};

const localInfo: EmbeddingSetModelInfo = {
  dimensions: 1024,
  modelConfig: localModelConfig,
  modelKey: 'jinaai/jina-embeddings-v3',
};

describe('useSearchEmbedder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVectorPreferencesStore.setState({ devicePref: 'wasm' });
    mockGenerateQueryEmbedding.mockReset();
    mockGenerateQueryEmbedding.mockResolvedValue({ embedding: new Array(1024).fill(0.25) });
    mockGenerateDocEmbedding.mockReset();
    mockGenerateDocEmbedding.mockResolvedValue({ embedding: new Array(1024).fill(0.5) });
    mockInitializeWithModel.mockReset();
    mockInitializeWithModel.mockResolvedValue(undefined);
    mockDispose.mockReset();
    mockDispose.mockResolvedValue(undefined);
    mockEmbed.mockReset();
    mockEmbed.mockResolvedValue({ ok: true, value: { embedding: new Array(1536).fill(0.1) } });
    mockCreateProvider.mockReset();
    mockCreateProvider.mockResolvedValue({ ok: true, value: { embed: mockEmbed } });
  });

  it('resolves a hosted embedder whose embedQuery maps provider results', async () => {
    const { result } = renderHook(() => useSearchEmbedder());
    const signal = new AbortController().signal;

    const embedder = await result.current.ensureEmbedderReady(hostedInfo);

    expect(embedder.runtime).toBe('hosted');
    const { embedding } = await embedder.embedQuery('hello', { signal });
    expect(embedding).toHaveLength(1536);
    expect(mockEmbed).toHaveBeenCalledWith({
      modelId: 'text-embedding-3-small',
      signal,
      text: 'hello',
    });
    expect(mockCreateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: 1536,
        modelId: 'text-embedding-3-small',
        provider: 'openai',
        runtime: 'hosted',
      })
    );
  });

  it('preserves a hosted provider AbortError without wrapping it', async () => {
    const abortError = new Error('Hosted embedding request was cancelled.');
    abortError.name = 'AbortError';
    mockEmbed.mockResolvedValue({
      error: { originalError: abortError, type: 'network_error' },
      ok: false,
    });
    const { result } = renderHook(() => useSearchEmbedder());
    const signal = new AbortController().signal;
    const embedder = await result.current.ensureEmbedderReady(hostedInfo);

    await expect(embedder.embedQuery('hello', { signal })).rejects.toBe(abortError);
  });

  it('uses local document semantics for saved content and query semantics for lookup context', async () => {
    const { result } = renderHook(() => useSearchEmbedder());
    const signal = new AbortController().signal;

    const embedder = await result.current.ensureEmbedderReady(localInfo);
    const document = await embedder.embedDocument('saved prompt text');
    const query = await embedder.embedQuery('current composer context', { signal });

    expect(document.embedding).toEqual(new Array(1024).fill(0.5));
    expect(query.embedding).toEqual(new Array(1024).fill(0.25));
    expect(mockGenerateDocEmbedding).toHaveBeenCalledWith('saved prompt text');
    expect(mockGenerateQueryEmbedding).toHaveBeenCalledWith('current composer context', {
      signal,
    });
  });

  it('creates distinct Cohere document and query providers with retrieval-correct input types', async () => {
    const { result } = renderHook(() => useSearchEmbedder());

    const embedder = await result.current.ensureEmbedderReady(cohereInfo);
    await embedder.embedDocument('saved prompt text');
    await embedder.embedQuery('current composer context');

    expect(mockCreateProvider).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        inputType: 'search_query',
        modelId: 'embed-english-v3.0',
        provider: 'cohere',
      })
    );
    expect(mockCreateProvider).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        inputType: 'search_document',
        modelId: 'embed-english-v3.0',
        provider: 'cohere',
      })
    );
  });

  it('creates distinct Voyage document and query providers with retrieval-correct input types', async () => {
    const { result } = renderHook(() => useSearchEmbedder());

    const embedder = await result.current.ensureEmbedderReady(voyageInfo);
    await embedder.embedDocument('saved prompt text');
    await embedder.embedQuery('current composer context');

    expect(mockCreateProvider).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ inputType: 'query', modelId: 'voyage-3', provider: 'voyage' })
    );
    expect(mockCreateProvider).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ inputType: 'document', modelId: 'voyage-3', provider: 'voyage' })
    );
  });

  it('reuses the cached embedder for the same model (factory called once)', async () => {
    const { result } = renderHook(() => useSearchEmbedder());

    const first = await result.current.ensureEmbedderReady(hostedInfo);
    const second = await result.current.ensureEmbedderReady(hostedInfo);

    expect(second).toBe(first);
    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a hosted embedder when the requested dimensions change', async () => {
    const { result } = renderHook(() => useSearchEmbedder());

    const first = await result.current.ensureEmbedderReady(hostedInfo);
    const second = await result.current.ensureEmbedderReady({
      ...hostedInfo,
      dimensions: 3072,
    });

    expect(second).not.toBe(first);
    expect(mockCreateProvider).toHaveBeenCalledTimes(2);
    expect(mockCreateProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ dimensions: 3072 })
    );
  });

  it('serializes distinct in-flight hosted initializations without deduplicating them', async () => {
    const providerResolvers: Array<
      (value: { ok: true; value: { embed: typeof mockEmbed } }) => void
    > = [];
    mockCreateProvider.mockImplementation(
      () =>
        new Promise((resolve) => {
          providerResolvers.push(resolve);
        })
    );
    const { result } = renderHook(() => useSearchEmbedder());

    const first = result.current.ensureEmbedderReady(hostedInfo);
    const firstRejection = expect(first).rejects.toThrow('was superseded');
    await waitFor(() => expect(mockCreateProvider).toHaveBeenCalledTimes(1));

    const second = result.current.ensureEmbedderReady({ ...hostedInfo, dimensions: 3072 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockCreateProvider).toHaveBeenCalledTimes(1);

    providerResolvers[0]?.({ ok: true, value: { embed: mockEmbed } });
    await firstRejection;
    await waitFor(() => expect(mockCreateProvider).toHaveBeenCalledTimes(2));
    providerResolvers[1]?.({ ok: true, value: { embed: mockEmbed } });
    const secondEmbedder = await second;

    const reused = await result.current.ensureEmbedderReady({
      ...hostedInfo,
      dimensions: 3072,
    });
    expect(reused).toBe(secondEmbedder);
    expect(mockCreateProvider).toHaveBeenCalledTimes(2);
  });

  it('rebuilds a local embedder when the device preference changes', async () => {
    const { result } = renderHook(() => useSearchEmbedder());

    const first = await result.current.ensureEmbedderReady(localInfo);
    expect(first.runtime).toBe('wasm');

    act(() => {
      useVectorPreferencesStore.setState({ devicePref: 'webgpu' });
    });
    const second = await result.current.ensureEmbedderReady(localInfo);

    expect(second).not.toBe(first);
    expect(second.runtime).toBe('webgpu');
    expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(2);
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('rebuilds a local embedder when its resolved model configuration changes', async () => {
    const { result } = renderHook(() => useSearchEmbedder());

    const first = await result.current.ensureEmbedderReady(localInfo);
    const second = await result.current.ensureEmbedderReady({
      ...localInfo,
      modelConfig: { ...localModelConfig, quantized: true },
    });

    expect(second).not.toBe(first);
    expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(2);
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('reuses a local embedder when only display metadata changes', async () => {
    const { result } = renderHook(() => useSearchEmbedder());

    const first = await result.current.ensureEmbedderReady(localInfo);
    const second = await result.current.ensureEmbedderReady({
      ...localInfo,
      modelConfig: {
        ...localModelConfig,
        contextWindow: 32_768,
        description: 'Updated settings description',
        name: 'Updated display name',
        pricePer1MTokens: 0,
        size: 'updated display size',
        supportedDimensions: [1024],
        tags: ['updated', 'display-only'],
      },
    });

    expect(second).toBe(first);
    expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(1);
    expect(mockDispose).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent first initialization for the same model', async () => {
    let resolveProvider!: (value: { ok: true; value: { embed: typeof mockEmbed } }) => void;
    mockCreateProvider.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProvider = resolve;
        })
    );
    const { result } = renderHook(() => useSearchEmbedder());

    const first = result.current.ensureEmbedderReady(hostedInfo);
    const second = result.current.ensureEmbedderReady(hostedInfo);
    await waitFor(() => expect(mockCreateProvider).toHaveBeenCalled());
    const factoryCallCountBeforeResolution = mockCreateProvider.mock.calls.length;
    resolveProvider({ ok: true, value: { embed: mockEmbed } });
    const [firstEmbedder, secondEmbedder] = await Promise.all([first, second]);

    expect(factoryCallCountBeforeResolution).toBe(1);
    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
    expect(secondEmbedder).toBe(firstEmbedder);
  });

  it('rejects a superseded initialization without overwriting the newer model cache', async () => {
    let resolveFirstInitialization!: () => void;
    mockInitializeWithModel.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFirstInitialization = resolve;
        })
    );
    let resolveSecondProvider!: (value: { ok: true; value: { embed: typeof mockEmbed } }) => void;
    mockCreateProvider.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSecondProvider = resolve;
        })
    );
    const { result } = renderHook(() => useSearchEmbedder());

    const first = result.current.ensureEmbedderReady(localInfo);
    const firstRejection = expect(first).rejects.toThrow(
      'Embedding initialization for jinaai/jina-embeddings-v3 was superseded by openai::text-embedding-3-small'
    );
    await waitFor(() => expect(mockInitializeWithModel).toHaveBeenCalledTimes(1));

    const second = result.current.ensureEmbedderReady(hostedInfo);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockCreateProvider).not.toHaveBeenCalled();

    resolveFirstInitialization();
    await firstRejection;
    await waitFor(() => expect(mockCreateProvider).toHaveBeenCalledTimes(1));
    resolveSecondProvider({ ok: true, value: { embed: mockEmbed } });
    const secondEmbedder = await second;

    expect(mockDispose).toHaveBeenCalledTimes(1);
    const reused = await result.current.ensureEmbedderReady(hostedInfo);
    expect(reused).toBe(secondEmbedder);
    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
  });

  it('serializes a superseding initialization behind cached embedder disposal', async () => {
    let resolveDisposal!: () => void;
    mockDispose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDisposal = resolve;
        })
    );
    const { result } = renderHook(() => useSearchEmbedder());

    await result.current.ensureEmbedderReady(localInfo);
    const superseded = result.current.ensureEmbedderReady(cohereInfo);
    const supersededRejection = expect(superseded).rejects.toThrow('was superseded');
    await waitFor(() => expect(mockDispose).toHaveBeenCalledTimes(1));

    const replacement = result.current.ensureEmbedderReady({
      ...hostedInfo,
      dimensions: 3072,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockCreateProvider).not.toHaveBeenCalled();

    resolveDisposal();
    await supersededRejection;
    await replacement;

    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
    expect(mockCreateProvider).toHaveBeenCalledWith(
      expect.objectContaining({ dimensions: 3072, provider: 'openai' })
    );
  });

  it('invalidates and disposes an in-flight initialization that completes after unmount', async () => {
    let resolveInitialization!: () => void;
    mockInitializeWithModel.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveInitialization = resolve;
        })
    );
    const { result, unmount } = renderHook(() => useSearchEmbedder());

    const pending = result.current.ensureEmbedderReady(localInfo);
    const rejection = expect(pending).rejects.toThrow('invalidated by unmount');
    await waitFor(() => expect(mockInitializeWithModel).toHaveBeenCalledTimes(1));

    unmount();
    resolveInitialization();
    await rejection;

    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('invalidates and disposes an in-flight WebGPU initialization when the document is hidden', async () => {
    const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    try {
      useVectorPreferencesStore.setState({ devicePref: 'webgpu' });
      let resolveInitialization!: () => void;
      mockInitializeWithModel.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveInitialization = resolve;
          })
      );
      const { result } = renderHook(() => useSearchEmbedder());

      const pending = result.current.ensureEmbedderReady(localInfo);
      const rejection = expect(pending).rejects.toThrow('invalidated by document-hidden');
      await waitFor(() => expect(mockInitializeWithModel).toHaveBeenCalledTimes(1));

      act(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      resolveInitialization();
      await rejection;

      expect(mockDispose).toHaveBeenCalledTimes(1);
    } finally {
      if (originalHidden) {
        Object.defineProperty(document, 'hidden', originalHidden);
      } else {
        Reflect.deleteProperty(document, 'hidden');
      }
    }
  });

  it('refuses to initialize a WebGPU embedder while the document is already hidden', async () => {
    const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    try {
      useVectorPreferencesStore.setState({ devicePref: 'webgpu' });
      const { result } = renderHook(() => useSearchEmbedder());

      await expect(result.current.ensureEmbedderReady(localInfo)).rejects.toThrow(
        'invalidated by document-hidden'
      );

      expect(MockSimpleEmbeddingService).not.toHaveBeenCalled();
    } finally {
      if (originalHidden) {
        Object.defineProperty(document, 'hidden', originalHidden);
      } else {
        Reflect.deleteProperty(document, 'hidden');
      }
    }
  });

  it('disposes a partially initialized local service and preserves both cleanup failures', async () => {
    const initializationError = new Error('local initialization failed');
    const disposalError = new Error('partial service disposal failed');
    mockInitializeWithModel.mockRejectedValue(initializationError);
    mockDispose.mockRejectedValue(disposalError);
    const { result } = renderHook(() => useSearchEmbedder());

    const error = await result.current.ensureEmbedderReady(localInfo).catch((cause) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([initializationError, disposalError]);
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('embedQueryWithRecovery retries exactly once on a device-loss error', async () => {
    mockGenerateQueryEmbedding.mockReset();
    mockGenerateQueryEmbedding
      .mockRejectedValueOnce(new Error('WebGPU device was lost: Device.Destroyed'))
      .mockResolvedValue({ embedding: new Array(1024).fill(0.5) });

    const { result } = renderHook(() => useSearchEmbedder());
    const signal = new AbortController().signal;

    const embedding = await result.current.embedQueryWithRecovery(localInfo, 'query', { signal });

    expect(embedding).toHaveLength(1024);
    // A fresh embedder is built for the retry.
    expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(2);
    expect(mockGenerateQueryEmbedding).toHaveBeenCalledTimes(2);
    expect(mockGenerateQueryEmbedding).toHaveBeenNthCalledWith(1, 'query', { signal });
    expect(mockGenerateQueryEmbedding).toHaveBeenNthCalledWith(2, 'query', { signal });
  });

  it('preserves AbortError without entering device-loss recovery', async () => {
    const abortError = new Error('WebGPU device was lost after query cancellation.');
    abortError.name = 'AbortError';
    mockGenerateQueryEmbedding.mockRejectedValue(abortError);
    const { result } = renderHook(() => useSearchEmbedder());
    const signal = new AbortController().signal;

    await expect(
      result.current.embedQueryWithRecovery(localInfo, 'query', { signal })
    ).rejects.toBe(abortError);

    expect(mockGenerateQueryEmbedding).toHaveBeenCalledTimes(1);
    expect(mockGenerateQueryEmbedding).toHaveBeenCalledWith('query', { signal });
    expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(1);
  });

  it('shares one recovery while concurrent device-loss callers await stale disposal', async () => {
    const queryRejectors: Array<(error: Error) => void> = [];
    mockGenerateQueryEmbedding
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            queryRejectors.push(reject);
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            queryRejectors.push(reject);
          })
      )
      .mockResolvedValue({ embedding: new Array(1024).fill(0.625) });
    let resolveDisposal!: () => void;
    mockDispose
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveDisposal = resolve;
          })
      )
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useSearchEmbedder());

    const first = result.current.embedQueryWithRecovery(localInfo, 'first query');
    const second = result.current.embedQueryWithRecovery(localInfo, 'second query');
    const recovered = Promise.all([first, second]).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ reason, status: 'rejected' as const })
    );
    await waitFor(() => expect(queryRejectors).toHaveLength(2));

    for (const reject of queryRejectors) {
      reject(new Error('WebGPU device was lost'));
    }
    await waitFor(() => expect(mockDispose).toHaveBeenCalledTimes(1));
    resolveDisposal();

    expect(await recovered).toEqual({
      status: 'fulfilled',
      value: [new Array(1024).fill(0.625), new Array(1024).fill(0.625)],
    });
    expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(2);
    expect(mockGenerateQueryEmbedding).toHaveBeenCalledTimes(4);
  });

  it('invalidates device-loss recovery that is awaiting disposal when the hook unmounts', async () => {
    mockGenerateQueryEmbedding.mockRejectedValueOnce(new Error('WebGPU device was lost'));
    let resolveDisposal!: () => void;
    mockDispose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDisposal = resolve;
        })
    );
    const { result, unmount } = renderHook(() => useSearchEmbedder());

    const recovery = result.current.embedQueryWithRecovery(localInfo, 'query');
    const settled = recovery.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ reason, status: 'rejected' as const })
    );
    await waitFor(() => expect(mockDispose).toHaveBeenCalledTimes(1));

    unmount();
    resolveDisposal();

    const outcome = await settled;
    expect(outcome.status).toBe('rejected');
    expect(outcome).toMatchObject({
      reason: expect.objectContaining({
        message: 'Device-loss recovery for jinaai/jina-embeddings-v3 was invalidated by unmount',
      }),
    });
    expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(1);
  });

  it('invalidates device-loss recovery when the document is hidden during disposal', async () => {
    const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    try {
      useVectorPreferencesStore.setState({ devicePref: 'webgpu' });
      mockGenerateQueryEmbedding.mockRejectedValueOnce(new Error('WebGPU device was lost'));
      let resolveDisposal!: () => void;
      mockDispose.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveDisposal = resolve;
          })
      );
      const { result } = renderHook(() => useSearchEmbedder());

      const recovery = result.current.embedQueryWithRecovery(localInfo, 'query');
      const rejection = expect(recovery).rejects.toThrow('invalidated by document-hidden');
      await waitFor(() => expect(mockDispose).toHaveBeenCalledTimes(1));

      act(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      resolveDisposal();

      await rejection;
      expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(1);
    } finally {
      if (originalHidden) {
        Object.defineProperty(document, 'hidden', originalHidden);
      } else {
        Reflect.deleteProperty(document, 'hidden');
      }
    }
  });

  it('does not dispose a healthy replacement when an older embedder reports device loss', async () => {
    let rejectFailedQuery!: (error: Error) => void;
    mockGenerateQueryEmbedding
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFailedQuery = reject;
          })
      )
      .mockResolvedValue({ embedding: new Array(1024).fill(0.75) });
    const { result } = renderHook(() => useSearchEmbedder());

    const recovery = result.current.embedQueryWithRecovery(localInfo, 'query');
    const recoveryRejection = expect(recovery).rejects.toThrow(
      'Device-loss recovery for jinaai/jina-embeddings-v3 was superseded'
    );
    await waitFor(() => expect(mockGenerateQueryEmbedding).toHaveBeenCalledTimes(1));

    act(() => {
      useVectorPreferencesStore.setState({ devicePref: 'webgpu' });
    });
    const replacement = await result.current.ensureEmbedderReady(localInfo);
    expect(replacement.runtime).toBe('webgpu');

    rejectFailedQuery(new Error('WebGPU device was lost'));
    await recoveryRejection;

    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(2);
    const reused = await result.current.ensureEmbedderReady(localInfo);
    expect(reused).toBe(replacement);
  });

  it('embedDocumentWithRecovery uses document semantics', async () => {
    const { result } = renderHook(() => useSearchEmbedder());

    const embedding = await result.current.embedDocumentWithRecovery(
      localInfo,
      'saved prompt text'
    );

    expect(embedding).toEqual(new Array(1024).fill(0.5));
    expect(mockGenerateDocEmbedding).toHaveBeenCalledWith('saved prompt text');
    expect(mockGenerateQueryEmbedding).not.toHaveBeenCalled();
  });

  it('embedQueryWithRecovery rethrows non-device-loss errors without rebuilding', async () => {
    mockGenerateQueryEmbedding.mockReset();
    mockGenerateQueryEmbedding.mockRejectedValue(new Error('out of memory'));

    const { result } = renderHook(() => useSearchEmbedder());

    await expect(result.current.embedQueryWithRecovery(localInfo, 'query')).rejects.toThrow(
      'out of memory'
    );
    expect(MockSimpleEmbeddingService).toHaveBeenCalledTimes(1);
  });
});
