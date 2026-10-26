import type {
  CanonicalHostedEmbeddings,
  CanonicalOperationContext,
  CanonicalSourceScope,
} from '@brainstrike/canonical-ingestion';
import {
  NativeCanonicalInference,
  NativeCanonicalProfileResolver,
  resolveNativeCanonicalProfile,
} from '@brainstrike/canonical-ingestion';
import type { VectorProfile } from '@brainstrike/indexer';
import type { CollectionPort, CollectionRecord, CollectionReply } from '@brainstrike/state-store';
import { describe, expect, it, vi } from 'vitest';

const metadata = {
  dimensions: 1536,
  distance: 'cosine',
  id: 'collection',
  modelId: 'text-embedding-3-small',
  modelKey: 'openai::text-embedding-3-small',
} as const satisfies Pick<
  CollectionRecord,
  'dimensions' | 'distance' | 'id' | 'modelId' | 'modelKey'
>;
const setRow = (change: Partial<CollectionRecord> = {}): CollectionRecord => ({
  ...metadata,
  createdAt: '2026-10-13T00:00:00.000Z',
  ...change,
});
const scope: CanonicalSourceScope = { kind: 'workspace', rootId: 'root' };
const profile = (): VectorProfile => resolveNativeCanonicalProfile(metadata).profile;
const request = (requestId = 'request') => ({
  chunks: [
    { chunkId: 'first', content: ' first content ' },
    { chunkId: 'second', content: 'second content' },
  ],
  profile: profile(),
  requestId,
});
const vector = (fill: number): number[] => new Array<number>(metadata.dimensions).fill(fill);
const vectors = (): number[][] => [vector(1), vector(2)];
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
  const collections = vi.fn<CollectionPort['collections']>(async () => ({
    collections: [setRow()],
  }));
  const resolveEmbeddingSetId = vi.fn(async () => metadata.id);
  const resolver = new NativeCanonicalProfileResolver({
    collections: { collections },
    resolveEmbeddingSetId,
  });
  const hostedEmbeddings = vi.fn<CanonicalHostedEmbeddings>(async () => vectors());
  const inference = new NativeCanonicalInference({ hostedEmbeddings, resolver, scope });
  return { collections, hostedEmbeddings, inference, resolveEmbeddingSetId, resolver };
}

describe('saved canonical profile identity', () => {
  it('uses actual model key metadata and never display names', () => {
    expect(resolveNativeCanonicalProfile(metadata)).toEqual({
      modelKey: metadata.modelKey,
      profile: {
        dimensions: 1536,
        distance: 'cosine',
        modelId: metadata.modelId,
        provider: 'openai',
      },
    });
    expect(() =>
      resolveNativeCanonicalProfile({ ...metadata, modelKey: 'text-embedding-3-small (1536D)' })
    ).toThrow(/provider\/model/);
    expect(() =>
      resolveNativeCanonicalProfile({ ...metadata, modelId: 'text-embedding-3-large' })
    ).toThrow(/modelId/);
  });

  it.each(['openai', 'google', 'cohere', 'voyage'] as const)(
    'preserves %s provider, dimensions and distance',
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
      });
    }
  );

  it('never accepts invalid saved dimensions', () => {
    expect(() => resolveNativeCanonicalProfile({ ...metadata, dimensions: 0 })).toThrow();
  });

  it('reads only the authorized collection and has no side effects on inference', async () => {
    const f = fixture();
    const context: CanonicalOperationContext = {
      requestId: 'resolve',
      signal: new AbortController().signal,
    };
    expect(await f.resolver.resolveProfile({ scope }, context)).toEqual(profile());
    expect(f.resolveEmbeddingSetId).toHaveBeenCalledWith(scope, context);
    expect(f.collections).toHaveBeenCalledWith({ id: metadata.id, operation: 'get' });
    expect(f.hostedEmbeddings).not.toHaveBeenCalled();
    expect(f.collections).toHaveBeenCalledTimes(1);
  });

  it('refuses absent, malformed or mismatched collection authority', async () => {
    const f = fixture();
    const context = { requestId: 'resolve', signal: new AbortController().signal };
    f.collections.mockResolvedValueOnce({ collections: [] });
    await expect(f.resolver.resolve(scope, context)).rejects.toThrow(/missing/);
    f.collections.mockResolvedValueOnce({ collections: [setRow({ id: 'different' })] });
    await expect(f.resolver.resolve(scope, context)).rejects.toThrow(/authorized/);
    f.collections.mockResolvedValueOnce({ collections: [setRow({ dimensions: Number.NaN })] });
    await expect(f.resolver.resolve(scope, context)).rejects.toThrow();
    expect(f.hostedEmbeddings).not.toHaveBeenCalled();
  });
});

describe('canonical inference ownership', () => {
  it('preserves ordered text, chunk IDs, full profile and the hosted document request', async () => {
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
    expect(f.hostedEmbeddings).toHaveBeenCalledWith({
      dimensions: metadata.dimensions,
      modelId: metadata.modelId,
      provider: 'openai',
      purpose: 'document',
      signal: expect.any(AbortSignal),
      texts: input.chunks.map((chunk) => chunk.content),
    });
    await f.inference.join(input.requestId);
    await f.inference.close();
  });

  it('admits exactly 64 ordered chunks and rejects oversized, empty or duplicate batches before transport', async () => {
    const f = fixture();
    const chunks = Array.from({ length: 64 }, (_, index) => ({
      chunkId: String(index),
      content: `text ${index}`,
    }));
    f.hostedEmbeddings.mockResolvedValueOnce(chunks.map(() => vector(1)));
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
    expect(f.hostedEmbeddings).toHaveBeenCalledTimes(1);
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
      f.hostedEmbeddings.mockResolvedValueOnce(
        Array.from({ length: chunks.length }, () => vector(1))
      );
      try {
        await expect(f.inference.generate({ ...request(), chunks })).rejects.toThrow(/sparse/);
        expect(f.resolveEmbeddingSetId).not.toHaveBeenCalled();
        expect(f.collections).not.toHaveBeenCalled();
        expect(f.hostedEmbeddings).not.toHaveBeenCalled();
      } finally {
        await f.inference.close();
      }
    }
  );

  it.each([
    { dimensions: 768 },
    { distance: 'ip' },
    { modelId: 'text-embedding-3-large' },
    { provider: 'google' },
  ])(
    'refuses a requested profile differing from fresh authoritative metadata %#',
    async (change) => {
      const f = fixture();
      const input = { ...request(), profile: { ...profile(), ...change } as VectorProfile };
      await expect(f.inference.generate(input)).rejects.toThrow(/profile/);
      expect(f.hostedEmbeddings).not.toHaveBeenCalled();
    }
  );

  it.each(
    [
      [],
      [vector(1)],
      [new Array<number>(metadata.dimensions - 1).fill(1), vector(2)],
      [vector(Number.NaN), vector(2)],
      [vector(Number.POSITIVE_INFINITY), vector(2)],
      [new Array<number>(metadata.dimensions), vector(2)],
      new Array<number[]>(2),
    ].map((output) => ({ output }))
  )('refuses malformed result cardinality, dimensions or numbers %#', async ({ output }) => {
    const f = fixture();
    f.hostedEmbeddings.mockResolvedValueOnce(output);
    await expect(f.inference.generate(request())).rejects.toThrow(/response/);
    await expect(f.inference.join('request')).resolves.toBeUndefined();
  });

  it.each(['l2', 'ip'] as const)(
    'preserves %s metric while generating unchanged model vectors',
    async (distance) => {
      const f = fixture();
      f.collections.mockResolvedValueOnce({ collections: [setRow({ distance })] });
      const result = await f.inference.generate({
        ...request(),
        profile: { ...profile(), distance },
      });
      expect(result.profile.distance).toBe(distance);
      expect(f.hostedEmbeddings).toHaveBeenCalledOnce();
      await f.inference.close();
    }
  );

  it('holds cancel and join through physical settlement and rejects late success', async () => {
    const f = fixture();
    const admitted = deferred<AbortSignal>();
    const held = deferred<number[][]>();
    f.hostedEmbeddings.mockImplementationOnce((input) => {
      admitted.resolve(input.signal);
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
    const held = deferred<CollectionReply>();
    const admitted = deferred<void>();
    f.collections.mockImplementationOnce(() => {
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
    held.resolve({ collections: [setRow()] });
    await Promise.all([canceled, rejected]);
    expect(f.hostedEmbeddings).not.toHaveBeenCalled();
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
    expect(f.hostedEmbeddings).toHaveBeenCalledTimes(1);
  });

  it('reports an uncancelled generation failure once and releases the settled request', async () => {
    const f = fixture();
    const failure = new Error('Embedding provider openai returned HTTP 500.');
    f.hostedEmbeddings.mockRejectedValueOnce(failure);
    await expect(f.inference.generate(request())).rejects.toBe(failure);
    // generate delivered the failure; cancel and join only prove physical settlement, so the
    // canonical host neither repeats it as a retirement fault nor keeps the request owned.
    await expect(f.inference.cancel('request')).resolves.toBeUndefined();
    await expect(f.inference.join('request')).resolves.toBeUndefined();
    await expect(f.inference.generate(request('next'))).resolves.toMatchObject({
      requestId: 'next',
    });
    await f.inference.join('next');
    await expect(f.inference.close()).resolves.toBeUndefined();
  });

  it('settles cancel and joins once a cancelled request ends, which only generate reports', async () => {
    const f = fixture();
    const admitted = deferred<void>();
    const held = deferred<number[][]>();
    f.hostedEmbeddings.mockImplementationOnce(() => {
      admitted.resolve();
      return held.promise;
    });
    const failure = new Error('cancellation delivery failed after joined retirement');
    const generated = f.inference.generate(request());
    const rejected = expect(generated).rejects.toBe(failure);
    await admitted.promise;
    const canceled = f.inference.cancel('request');
    const joined = f.inference.join('request');
    const concurrentJoin = f.inference.join('request');
    const retired = vi.fn();
    joined.then(retired, retired);
    await Promise.resolve();
    expect(retired).not.toHaveBeenCalled();
    held.reject(failure);
    await rejected;
    await expect(Promise.all([canceled, joined, concurrentJoin])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(retired).toHaveBeenCalledOnce();
    // No physical request remains to block a later close. Its ID still cannot be replayed.
    await expect(f.inference.generate(request())).rejects.toThrow(/already/);
    await expect(f.inference.close()).resolves.toBeUndefined();
  });

  it('closes once a request it cancelled settles, which only generate reports', async () => {
    const f = fixture();
    const admitted = deferred<AbortSignal>();
    const physical = deferred<number[][]>();
    f.hostedEmbeddings.mockImplementationOnce((input) => {
      admitted.resolve(input.signal);
      return physical.promise;
    });
    const failure = new Error('cancellation delivery failed after joined retirement');
    const generated = f.inference.generate(request());
    const generatedFailure = expect(generated).rejects.toBe(failure);
    const signal = await admitted.promise;
    const closed = f.inference.close();
    const retired = vi.fn();
    closed.then(retired, retired);
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(retired).not.toHaveBeenCalled();
    physical.reject(failure);
    await generatedFailure;
    await expect(closed).resolves.toBeUndefined();
    expect(retired).toHaveBeenCalledOnce();
  });

  it('does not let stale cancellation affect a different request', async () => {
    const f = fixture();
    await f.inference.generate(request('old'));
    await f.inference.join('old');
    const held = deferred<number[][]>();
    const admitted = deferred<AbortSignal>();
    f.hostedEmbeddings.mockImplementationOnce((input) => {
      admitted.resolve(input.signal);
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

it.each(['openai', 'google', 'cohere', 'voyage'] as const)(
  'canonical document inference preserves durable %s identity and ordered batch',
  async (provider) => {
    const saved = {
      ...metadata,
      dimensions: 768,
      modelId: 'saved-model',
      modelKey: `${provider}::saved-model`,
    };
    const resolver = new NativeCanonicalProfileResolver({
      collections: { collections: async () => ({ collections: [setRow(saved)] }) },
      resolveEmbeddingSetId: async () => saved.id,
    });
    const hostedEmbeddings = vi.fn(async () => [
      new Array<number>(768).fill(1),
      new Array<number>(768).fill(2),
    ]);
    const inference = new NativeCanonicalInference({ hostedEmbeddings, resolver, scope });
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
    await inference.close();
  }
);
