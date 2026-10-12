import type {
  CanonicalOperationContext,
  CanonicalSourceScope,
} from '@brainstrike/canonical-ingestion';
import type { EmbeddingSet } from '@brainstrike/db';
import type { SelectedEmbeddingRequestPlan } from '@brainstrike/embeddings/inference-plan';
import type { VectorProfile } from '@brainstrike/indexer';
import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingHostDocumentEmbeddingsPayload } from '../embedding-host-shared';
import {
  NativeCanonicalInference,
  NativeCanonicalProfileResolver,
  resolveNativeCanonicalProfile,
} from '../native-canonical-profile';

const metadata = {
  dimensions: 384,
  distance: 'cosine',
  id: 'collection',
  modelId: 'Xenova/bge-small-en-v1.5',
  modelKey: 'local::Xenova/bge-small-en-v1.5',
} as const satisfies Pick<EmbeddingSet, 'dimensions' | 'distance' | 'id' | 'modelId' | 'modelKey'>;
const selection = {
  device: 'wasm',
  dimensions: metadata.dimensions,
  dtype: 'q8',
  modelId: metadata.modelId,
} as const satisfies SelectedEmbeddingRequestPlan;
// The set row as the resolver reads it, joined to its catalog `models` row.
const setRow = (change: Record<string, unknown> = {}) => ({
  ...metadata,
  catalogCapabilities: { defaultDimension: 384, type: 'embedding' },
  catalogParameters: { size: '~34MB' },
  ...change,
});
const GRANITE_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
const GRANITE_REVISION = '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8';
const graniteRow = {
  catalogCapabilities: { defaultDimension: 384, pooling: 'cls', type: 'embedding' },
  catalogParameters: {
    execution: { wasm: 'q8', webgpu: 'fp16' },
    revision: GRANITE_REVISION,
  },
  dimensions: 384,
  distance: 'cosine',
  id: 'collection',
  modelId: GRANITE_ID,
  modelKey: `local::${GRANITE_ID}`,
};
const scope: CanonicalSourceScope = { embeddingSetId: metadata.id, kind: 'collection' };
const profile = (): VectorProfile => resolveNativeCanonicalProfile(metadata, selection).profile;
const request = (requestId = 'request') => ({
  chunks: [
    { chunkId: 'first', content: ' first content ' },
    { chunkId: 'second', content: 'second content' },
  ],
  profile: profile(),
  requestId,
});
const vectors = (): number[][] => [new Array<number>(384).fill(1), new Array<number>(384).fill(2)];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
function fixture() {
  const query = vi.fn(async (): Promise<{ rows: unknown[] }> => ({ rows: [setRow()] }));
  const resolveEmbeddingSetId = vi.fn(async () => metadata.id);
  const readLocalSelection = vi.fn(async (): Promise<SelectedEmbeddingRequestPlan> => selection);
  const resolver = new NativeCanonicalProfileResolver({
    query,
    readLocalSelection,
    resolveEmbeddingSetId,
  });
  const documentEmbeddings = vi.fn(
    async (
      _payload: EmbeddingHostDocumentEmbeddingsPayload,
      _options?: { signal?: AbortSignal }
    ): Promise<number[][]> => vectors()
  );
  const inference = new NativeCanonicalInference({
    resolver,
    scope,
    transport: { documentEmbeddings },
  });
  return {
    documentEmbeddings,
    inference,
    query,
    readLocalSelection,
    resolveEmbeddingSetId,
    resolver,
  };
}

describe('saved canonical profile identity', () => {
  it('uses actual model key metadata and never display names', () => {
    expect(resolveNativeCanonicalProfile(metadata, selection)).toEqual({
      modelKey: metadata.modelKey,
      profile: {
        dimensions: 384,
        distance: 'cosine',
        dtype: 'q8',
        modelId: metadata.modelId,
        provider: 'local',
      },
      workerPlan: selection,
    });
    expect(() =>
      resolveNativeCanonicalProfile({ ...metadata, modelKey: 'MiniLM (384D)' }, selection)
    ).toThrow(/provider\/model/);
    expect(() =>
      resolveNativeCanonicalProfile({ ...metadata, modelId: 'MiniLM' }, selection)
    ).toThrow(/modelId/);
  });

  it.each(['openai', 'google', 'cohere', 'voyage', 'ollama', 'lmstudio'] as const)(
    'preserves %s provider, dimensions and distance without local qualification',
    (provider) => {
      const saved = {
        ...metadata,
        dimensions: 1536,
        distance: 'ip' as const,
        modelId: 'saved-model',
        modelKey: `${provider}::saved-model`,
      };
      expect(resolveNativeCanonicalProfile(saved)).toEqual({
        modelKey: saved.modelKey,
        profile: { dimensions: 1536, distance: 'ip', modelId: 'saved-model', provider },
        workerPlan: null,
      });
    }
  );

  it.each([undefined, { ...selection, device: undefined }, { ...selection, dtype: undefined }])(
    'refuses missing or unverified local pins %#',
    (saved) => {
      expect(() => resolveNativeCanonicalProfile(metadata, saved)).toThrow(/explicit|execution/);
    }
  );

  it('preserves existing Jina model dimensions without fabricated pins', () => {
    const saved = {
      ...metadata,
      dimensions: 768,
      modelId: 'jinaai/jina-embeddings-v2-base-code',
      modelKey: 'transformers::jinaai/jina-embeddings-v2-base-code',
    };
    const chosen = {
      device: 'webgpu' as const,
      dimensions: saved.dimensions,
      dtype: 'fp32',
      modelId: saved.modelId,
    };
    expect(resolveNativeCanonicalProfile(saved, chosen).profile).toEqual({
      dimensions: 768,
      distance: 'cosine',
      dtype: 'fp32',
      modelId: saved.modelId,
      provider: 'transformers',
    });
  });

  it('never replaces saved dimensions or mismatched selected identity', () => {
    expect(() =>
      resolveNativeCanonicalProfile({ ...metadata, dimensions: 768 }, selection)
    ).toThrow(/selection/);
    expect(() =>
      resolveNativeCanonicalProfile(metadata, { ...selection, modelId: 'other' })
    ).toThrow(/selection/);
    expect(() =>
      resolveNativeCanonicalProfile({ ...metadata, dimensions: 0 }, selection)
    ).toThrow();
  });

  it('reads only the authorized PG set and has no side effects on preferences or inference', async () => {
    const f = fixture();
    const context: CanonicalOperationContext = {
      requestId: 'resolve',
      signal: new AbortController().signal,
    };
    expect(await f.resolver.resolveProfile({ scope }, context)).toEqual(profile());
    expect(f.resolveEmbeddingSetId).toHaveBeenCalledWith(scope, context);
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('FROM embedding_sets e'), [
      metadata.id,
    ]);
    expect(f.documentEmbeddings).not.toHaveBeenCalled();
    expect(f.readLocalSelection).toHaveBeenCalledWith(metadata, context);
    expect(f.query).toHaveBeenCalledTimes(1);
  });

  it('takes the granite pooling and pin from its catalog row into the profile and plan (BST-1993)', async () => {
    const f = fixture();
    const chosen = {
      device: 'webgpu' as const,
      dimensions: 384,
      dtype: 'fp16',
      modelId: GRANITE_ID,
      revision: GRANITE_REVISION,
    };
    f.query.mockResolvedValue({ rows: [graniteRow] });
    f.readLocalSelection.mockResolvedValue(chosen);
    const context = { requestId: 'resolve', signal: new AbortController().signal };
    expect(await f.resolver.resolve(scope, context)).toEqual({
      modelKey: graniteRow.modelKey,
      profile: {
        dimensions: 384,
        distance: 'cosine',
        dtype: 'fp16',
        modelId: GRANITE_ID,
        pooling: 'cls',
        provider: 'local',
        revision: GRANITE_REVISION,
      },
      workerPlan: { ...chosen, pooling: 'cls' },
    });
    // The bge row states no pooling: its plan and profile stay exactly as before.
    f.query.mockResolvedValue({ rows: [setRow()] });
    f.readLocalSelection.mockResolvedValue(selection);
    expect(await f.resolver.resolve(scope, context)).toEqual(
      resolveNativeCanonicalProfile(metadata, selection)
    );
  });

  it('refuses a granite selection without the catalog pin, and a local model outside the catalog', async () => {
    const f = fixture();
    const context = { requestId: 'resolve', signal: new AbortController().signal };
    f.query.mockResolvedValueOnce({ rows: [graniteRow] });
    f.readLocalSelection.mockResolvedValueOnce({
      device: 'webgpu',
      dimensions: 384,
      dtype: 'fp16',
      modelId: GRANITE_ID,
    });
    await expect(f.resolver.resolve(scope, context)).rejects.toThrow(/pinned revision/);
    f.query.mockResolvedValueOnce({
      rows: [setRow({ catalogCapabilities: null, catalogParameters: null })],
    });
    await expect(f.resolver.resolve(scope, context)).rejects.toThrow(/not in the model catalog/);
  });

  it('refuses absent, malformed or mismatched PG authority', async () => {
    const f = fixture();
    const context = { requestId: 'resolve', signal: new AbortController().signal };
    f.query.mockResolvedValueOnce({ rows: [] });
    await expect(f.resolver.resolve(scope, context)).rejects.toThrow(/missing/);
    f.query.mockResolvedValueOnce({ rows: [setRow({ id: 'different' })] });
    await expect(f.resolver.resolve(scope, context)).rejects.toThrow(/authorized/);
    f.query.mockResolvedValueOnce({ rows: [setRow({ dimensions: Number.NaN })] });
    await expect(f.resolver.resolve(scope, context)).rejects.toThrow();
    expect(f.documentEmbeddings).not.toHaveBeenCalled();
  });
});

describe('canonical inference ownership', () => {
  it('preserves ordered text, chunk IDs, full profile and exact worker plan', async () => {
    const f = fixture();
    const input = request();
    expect(await f.inference.generate(input)).toEqual({
      profile: profile(),
      requestId: input.requestId,
      vectors: [
        { chunkId: 'first', vector: vectors()[0] },
        { chunkId: 'second', vector: vectors()[1] },
      ],
    });
    expect(f.documentEmbeddings).toHaveBeenCalledWith(
      {
        dimensions: 384,
        inferencePlan: selection,
        modelId: metadata.modelId,
        modelKey: metadata.modelKey,
        texts: input.chunks.map((chunk) => chunk.content),
      },
      { signal: expect.any(AbortSignal) }
    );
    await f.inference.join(input.requestId);
    await f.inference.close();
  });

  it('admits exactly 64 ordered chunks and rejects oversized, empty or duplicate batches before transport', async () => {
    const f = fixture();
    const chunks = Array.from({ length: 64 }, (_, index) => ({
      chunkId: String(index),
      content: `text ${index}`,
    }));
    f.documentEmbeddings.mockResolvedValueOnce(chunks.map(() => new Array<number>(384).fill(1)));
    const result = await f.inference.generate({ ...request(), chunks });
    expect(result.vectors.map((entry) => entry.chunkId)).toEqual(
      chunks.map((chunk) => chunk.chunkId)
    );
    for (const invalid of [
      [],
      [...chunks, { chunkId: '65', content: 'text' }],
      [chunks[0]!, chunks[0]!],
      [{ chunkId: 'empty', content: ' ' }],
    ]) {
      await expect(
        f.inference.generate({ ...request('invalid'), chunks: invalid })
      ).rejects.toThrow();
    }
    expect(f.documentEmbeddings).toHaveBeenCalledTimes(1);
    await f.inference.close();
  });

  it.each([
    {
      caseName: 'wholly sparse',
      makeChunks: () => new Array<ReturnType<typeof request>['chunks'][number]>(1),
    },
    {
      caseName: 'mixed dense and sparse',
      makeChunks: () => {
        const chunks = new Array<ReturnType<typeof request>['chunks'][number]>(3);
        chunks[0] = { chunkId: 'first', content: 'first content' };
        chunks[2] = { chunkId: 'third', content: 'third content' };
        return chunks;
      },
    },
  ])(
    'rejects $caseName chunk batches before authority or transport admission',
    async ({ makeChunks }) => {
      const f = fixture();
      const chunks = makeChunks();
      f.documentEmbeddings.mockResolvedValueOnce(
        Array.from({ length: chunks.length }, () => new Array<number>(384).fill(1))
      );
      try {
        await expect(f.inference.generate({ ...request(), chunks })).rejects.toThrow(/sparse/);
        expect(f.resolveEmbeddingSetId).not.toHaveBeenCalled();
        expect(f.query).not.toHaveBeenCalled();
        expect(f.readLocalSelection).not.toHaveBeenCalled();
        expect(f.documentEmbeddings).not.toHaveBeenCalled();
      } finally {
        await f.inference.close();
      }
    }
  );

  it.each([
    { dimensions: 768 },
    { distance: 'ip' },
    { tokenCap: 256 },
    { provider: 'transformers' },
    { revision: 'a'.repeat(40) },
    { dtype: 'fp32' },
  ])(
    'refuses a requested profile differing from fresh authoritative metadata %#',
    async (change) => {
      const f = fixture();
      const input = { ...request(), profile: { ...profile(), ...change } as VectorProfile };
      await expect(f.inference.generate(input)).rejects.toThrow(/profile/);
      expect(f.documentEmbeddings).not.toHaveBeenCalled();
    }
  );

  it.each(
    [
      [],
      [new Array<number>(384).fill(1)],
      [new Array<number>(383).fill(1), new Array<number>(384).fill(2)],
      [new Array<number>(384).fill(Number.NaN), new Array<number>(384).fill(2)],
      [new Array<number>(384).fill(Number.POSITIVE_INFINITY), new Array<number>(384).fill(2)],
      [new Array<number>(384), new Array<number>(384).fill(2)],
      new Array<number[]>(2),
    ].map((output) => ({ output }))
  )('refuses malformed result cardinality, dimensions or numbers %#', async ({ output }) => {
    const f = fixture();
    f.documentEmbeddings.mockResolvedValueOnce(output);
    await expect(f.inference.generate(request())).rejects.toThrow(/response/);
    await expect(f.inference.join('request')).rejects.toThrow(/response/);
  });

  it.each(['l2', 'ip'] as const)(
    'preserves %s metric while generating unchanged model vectors',
    async (distance) => {
      const f = fixture();
      f.query.mockResolvedValueOnce({ rows: [setRow({ distance })] });
      const result = await f.inference.generate({
        ...request(),
        profile: { ...profile(), distance },
      });
      expect(result.profile.distance).toBe(distance);
      expect(f.documentEmbeddings).toHaveBeenCalledOnce();
      await f.inference.close();
    }
  );

  it('holds cancel and join through physical settlement and rejects late success', async () => {
    const f = fixture();
    const admitted = deferred<AbortSignal>();
    const held = deferred<number[][]>();
    f.documentEmbeddings.mockImplementationOnce((_payload, options) => {
      admitted.resolve(options!.signal!);
      return held.promise;
    });
    const generated = f.inference.generate(request());
    const rejected = expect(generated).rejects.toMatchObject({ name: 'AbortError' });
    const signal = await admitted.promise;
    const canceled = f.inference.cancel('request');
    const joined = f.inference.join('request');
    const retired = vi.fn();
    canceled.then(retired);
    joined.then(retired);
    try {
      await Promise.resolve();
      expect(signal.aborted).toBe(true);
      expect(retired).not.toHaveBeenCalled();
      await expect(f.inference.generate(request())).rejects.toThrow(/already/);
    } finally {
      held.resolve(vectors());
      await Promise.all([canceled, joined, rejected]);
    }
    expect(retired).toHaveBeenCalledTimes(2);
    await expect(f.inference.generate(request())).rejects.toThrow(/already/);
    await f.inference.close();
  });

  it('joins authority reads canceled before admission without sending texts', async () => {
    const f = fixture();
    const held = deferred<{ rows: (typeof metadata)[] }>();
    const admitted = deferred<void>();
    f.query.mockImplementationOnce(() => {
      admitted.resolve();
      return held.promise;
    });
    const generated = f.inference.generate(request());
    const rejected = expect(generated).rejects.toMatchObject({ name: 'AbortError' });
    await admitted.promise;
    const canceled = f.inference.cancel('request');
    const retired = vi.fn();
    canceled.then(retired);
    await Promise.resolve();
    expect(retired).not.toHaveBeenCalled();
    held.resolve({ rows: [metadata] });
    await Promise.all([canceled, rejected]);
    expect(f.documentEmbeddings).not.toHaveBeenCalled();
  });

  it('registers ownership before admission and snapshots mutable caller identity', async () => {
    const f = fixture();
    const input = request('immutable');
    const generated = f.inference.generate(input);
    input.requestId = 'mutated';
    input.chunks.reverse();
    const result = await generated;
    expect(result.requestId).toBe('immutable');
    expect(result.vectors.map((entry) => entry.chunkId)).toEqual(['first', 'second']);
    await f.inference.join('immutable');
    const rejected = expect(f.inference.generate(request('reentrant'))).rejects.toMatchObject({
      name: 'AbortError',
    });
    const canceled = f.inference.cancel('reentrant');
    await Promise.all([rejected, canceled]);
    expect(f.documentEmbeddings).toHaveBeenCalledTimes(1);
  });

  it('keeps cancellation and cleanup errors visible after held completion', async () => {
    const f = fixture();
    const admitted = deferred<void>();
    const held = deferred<number[][]>();
    f.documentEmbeddings.mockImplementationOnce(() => {
      admitted.resolve();
      return held.promise;
    });
    const failure = new Error('cancellation delivery failed after joined retirement');
    const generated = f.inference.generate(request());
    const rejected = expect(generated).rejects.toBe(failure);
    await admitted.promise;
    const canceled = f.inference.cancel('request');
    const cancelRejected = expect(canceled).rejects.toBe(failure);
    held.reject(failure);
    await Promise.all([rejected, cancelRejected]);
    await expect(f.inference.join('request')).rejects.toBe(failure);
    await expect(f.inference.close()).rejects.toThrow(/retirement/);
  });

  it('does not let stale cancellation affect a different request', async () => {
    const f = fixture();
    await f.inference.generate(request('old'));
    await f.inference.join('old');
    const held = deferred<number[][]>();
    const admitted = deferred<AbortSignal>();
    f.documentEmbeddings.mockImplementationOnce((_payload, options) => {
      admitted.resolve(options!.signal!);
      return held.promise;
    });
    const generated = f.inference.generate(request('new'));
    const signal = await admitted.promise;
    await f.inference.cancel('old');
    expect(signal.aborted).toBe(false);
    held.resolve(vectors());
    await generated;
    await f.inference.close();
    await expect(f.inference.generate(request('closed'))).rejects.toThrow(/closed/);
  });
});

it.each(['openai', 'google', 'cohere', 'voyage', 'ollama', 'lmstudio'] as const)(
  'canonical document inference preserves durable %s identity and ordered batch',
  async (provider) => {
    const saved = {
      ...metadata,
      dimensions: 768,
      modelId: 'saved-model',
      modelKey: `${provider}::saved-model`,
    };
    const resolver = new NativeCanonicalProfileResolver({
      query: async () => ({ rows: [saved] }),
      readLocalSelection: async () => undefined,
      resolveEmbeddingSetId: async () => saved.id,
    });
    const documentEmbeddings = vi.fn();
    const hostedEmbeddings = vi.fn(async () => [
      new Array<number>(768).fill(1),
      new Array<number>(768).fill(2),
    ]);
    const inference = new NativeCanonicalInference({
      hostedEmbeddings,
      resolver,
      scope,
      transport: { documentEmbeddings },
    });
    const input = { ...request(), profile: resolveNativeCanonicalProfile(saved).profile };
    const result = await inference.generate(input);
    expect(result.vectors.map((entry) => entry.chunkId)).toEqual(['first', 'second']);
    expect(result.vectors.every((entry) => entry.vector.length === 768)).toBe(true);
    expect(hostedEmbeddings).toHaveBeenCalledWith({
      dimensions: saved.dimensions,
      modelId: saved.modelId,
      provider,
      purpose: 'document',
      signal: expect.any(AbortSignal),
      texts: input.chunks.map((chunk) => chunk.content),
    });
    expect(documentEmbeddings).not.toHaveBeenCalled();
    await inference.close();
  }
);
