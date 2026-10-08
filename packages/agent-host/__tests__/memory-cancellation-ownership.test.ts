import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { InMemoryStore } from '@mastra/core/storage';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { Memory } from '@mastra/memory';
import { streamText } from 'ai';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HostMemory } from '../src/adapters/memory.js';
import { MemoryProviderLifetime } from '../src/adapters/memory-provider-lifetime.js';
import { scriptedModel } from './fixtures/scripted-model.js';

const fetch = vi.fn(async () => {
  throw new Error('Ownership controls make no provider requests');
});
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

function rawEmbedding(failure?: unknown) {
  const entered = Promise.withResolvers<AbortSignal | undefined>();
  const release = Promise.withResolvers<void>();
  let retired = false;
  const model: MastraEmbeddingModel<string> = {
    doEmbed: async ({ abortSignal, values }) => {
      entered.resolve(abortSignal);
      await release.promise;
      retired = true;
      if (failure !== undefined) {
        throw failure;
      }
      return { embeddings: values.map(() => [1]), usage: { tokens: values.length }, warnings: [] };
    },
    maxEmbeddingsPerCall: 1,
    modelId: 'recorded-cancellation-control',
    provider: 'local-fixture',
    specificationVersion: 'v3',
    supportsParallelCalls: true,
  };
  return { entered, model, release, retired: () => retired };
}

async function ownedFixture(reason = new Error('Recorded owner cancellation')) {
  const controller = new AbortController();
  const lifetime = new MemoryProviderLifetime(controller.signal, async () => undefined);
  const raw = rawEmbedding();
  const wrapped = lifetime.embedding(raw.model);
  const calls = [0, 1].map((ordinal) =>
    Promise.resolve(wrapped.doEmbed({ values: [`recorded input ${ordinal}`] })).catch(
      (cause: unknown) => cause
    )
  );
  expect(await raw.entered.promise).toBe(controller.signal);
  await setImmediate();
  controller.abort(reason);
  raw.release.resolve();
  const causes: Error[] = [];
  for (const cause of await Promise.all(calls)) {
    if (!(cause instanceof Error)) {
      throw new Error('The actual embedding enclosure did not return a cancellation object');
    }
    expect(cause.cause).toBe(reason);
    expect(lifetime.ownsCancellation(cause)).toBe(true);
    causes.push(cause);
  }
  expect(raw.retired()).toBe(true);
  const [first, second] = causes;
  if (!(first && second)) {
    throw new Error('Two original cancellation objects are required');
  }
  return { first, lifetime, reason, second };
}

test('same-enclosure nested aggregates preserve verified original cancellation membership', async () => {
  const f = await ownedFixture();
  try {
    const inner = new AggregateError([f.first, f.second], 'Recorded aggregate membership');
    expect(
      f.lifetime.ownsCancellation(
        new AggregateError([inner, f.first, inner], 'Recorded aggregate membership')
      )
    ).toBe(true);
    expect(inner.errors).toEqual([f.first, f.second]);
  } finally {
    await f.lifetime.join();
  }
});

const unownedCases: {
  label: string;
  build: (first: Error, second: Error, reason: Error) => unknown;
}[] = [
  {
    build: (first) =>
      new AggregateError(
        [first, new Error('Independent fixture failure')],
        'Recorded aggregate membership'
      ),
    label: 'mixed genuine provider failure',
  },
  {
    build: (first) =>
      new AggregateError(
        [first, new DOMException('Independent fixture abort', 'AbortError')],
        'Recorded aggregate membership'
      ),
    label: 'coincident independent AbortError',
  },
  {
    build: (first, _, reason) =>
      new AggregateError([first, reason], 'Recorded aggregate membership'),
    label: 'original reason in cleanup',
  },
  {
    build: (first, _, reason) =>
      new AggregateError(
        [first, Object.assign(new Error(first.message, { cause: reason }), { name: first.name })],
        'Recorded aggregate membership'
      ),
    label: 'copied name/message/cause',
  },
  {
    build: (first, second) =>
      new AggregateError(
        [new Error('Independent wrapper', { cause: first }), second],
        'Recorded aggregate membership'
      ),
    label: 'opaque cause wrapper',
  },
  {
    build: (first, second) =>
      new AggregateError(
        [
          new AggregateError(
            [first, new Error('Nested genuine fixture failure')],
            'Recorded aggregate membership'
          ),
          second,
        ],
        'Recorded aggregate membership'
      ),
    label: 'nested genuine leaf',
  },
  {
    build: (first) =>
      new AggregateError([first, 'original fixture thrown value'], 'Recorded aggregate membership'),
    label: 'unowned thrown primitive',
  },
  {
    build: () => new AggregateError([], 'Recorded aggregate membership'),
    label: 'empty aggregate',
  },
  {
    build: (first) =>
      new AggregateError(
        [first, new AggregateError([], 'Recorded aggregate membership')],
        'Recorded aggregate membership'
      ),
    label: 'nested empty aggregate',
  },
  {
    build: (first) => {
      const error = new AggregateError([first], 'Recorded aggregate membership');
      Reflect.set(error, 'errors', { 0: first, length: 1 });
      return error;
    },
    label: 'malformed errors value',
  },
  {
    build: () => {
      const error = new AggregateError([], 'Recorded aggregate membership');
      Reflect.deleteProperty(error, 'errors');
      return error;
    },
    label: 'missing errors value',
  },
  {
    build: (first) => {
      const error = new AggregateError([first], 'Recorded aggregate membership');
      const errors: unknown[] = [first];
      errors.length = 2;
      Reflect.set(error, 'errors', errors);
      return error;
    },
    label: 'sparse aggregate membership',
  },
  {
    build: (first) => {
      const error = new AggregateError([first], 'Recorded aggregate membership');
      Reflect.set(error, 'errors', [first, error]);
      return error;
    },
    label: 'cyclic aggregate membership',
  },
  {
    build: () => {
      const error = new AggregateError([], 'Recorded aggregate membership');
      Object.defineProperty(error, 'errors', {
        get: () => {
          throw new Error('Fixture malformed accessor');
        },
      });
      return error;
    },
    label: 'throwing errors accessor',
  },
  {
    build: (first, second) => {
      const error = new AggregateError([], 'Recorded aggregate membership');
      Object.defineProperty(error, 'errors', { get: () => [first, second] });
      return error;
    },
    label: 'errors accessor returning owned leaves',
  },
  {
    build: (first, second) => {
      const error = new AggregateError([], 'Recorded aggregate membership');
      const members = [first, second];
      Object.defineProperty(members, '1', { get: () => second });
      Reflect.set(error, 'errors', members);
      return error;
    },
    label: 'member accessor returning an owned leaf',
  },
  {
    build: (first) => {
      const genuine = new Error('Repeated genuine fixture failure');
      return new AggregateError(
        [genuine, first, new AggregateError([genuine], 'Recorded aggregate membership')],
        'Recorded aggregate membership'
      );
    },
    label: 'repeated unowned reference',
  },
];

test.each(unownedCases)('$label cannot become an owned cancellation', async ({ build }) => {
  const f = await ownedFixture();
  try {
    const original = build(f.first, f.second, f.reason);
    expect(f.lifetime.ownsCancellation(original)).toBe(false);
  } finally {
    await f.lifetime.join();
  }
});

test('foreign-enclosure cancellation stays unowned even when both owners use the exact same reason', async () => {
  const reason = new Error('Shared recorded reason object');
  const a = await ownedFixture(reason);
  const b = await ownedFixture(reason);
  try {
    expect(a.lifetime.ownsCancellation(b.first)).toBe(false);
    expect(
      a.lifetime.ownsCancellation(
        new AggregateError([a.first, b.first], 'Recorded aggregate membership')
      )
    ).toBe(false);
    expect(
      a.lifetime.ownsCancellation(
        new AggregateError(
          [new AggregateError([a.first, b.first], 'Recorded aggregate membership'), a.second],
          'Recorded aggregate membership'
        )
      )
    ).toBe(false);
    expect(b.first.cause).toBe(a.first.cause);
  } finally {
    await Promise.all([a.lifetime.join(), b.lifetime.join()]);
  }
});

test('recognizing a retired cancellation aggregate cannot retire another admitted raw call', async () => {
  const controller = new AbortController();
  const lifetime = new MemoryProviderLifetime(controller.signal, async () => undefined);
  const raw = [rawEmbedding(), rawEmbedding(), rawEmbedding()];
  const calls = raw.map((leaf, ordinal) =>
    Promise.resolve(
      lifetime.embedding(leaf.model).doEmbed({ values: [`recorded input ${ordinal}`] })
    ).catch((cause: unknown) => cause)
  );
  let joined = false;
  try {
    expect(await Promise.all(raw.map((leaf) => leaf.entered.promise))).toEqual(
      raw.map(() => controller.signal)
    );
    controller.abort(new Error('Recorded owner cancellation'));
    raw[0]?.release.resolve();
    raw[1]?.release.resolve();
    const aggregate = new AggregateError(
      await Promise.all(calls.slice(0, 2)),
      'Recorded aggregate membership'
    );
    expect(lifetime.ownsCancellation(aggregate)).toBe(true);
    const closing = lifetime.join().then(() => {
      joined = true;
    });
    await setImmediate();
    expect(joined).toBe(false);
    expect(raw[2]?.retired()).toBe(false);
    raw[2]?.release.resolve();
    await closing;
    expect(raw.every((leaf) => leaf.retired())).toBe(true);
  } finally {
    for (const leaf of raw) {
      leaf.release.resolve();
    }
    await Promise.allSettled(calls);
    await lifetime.join();
  }
});

test.each(['error', 'independent-abort'] as const)(
  'mixed original raw provider %s still fails after every raw call joins',
  async (kind) => {
    const controller = new AbortController();
    const lifetime = new MemoryProviderLifetime(controller.signal, async () => undefined);
    const genuine =
      kind === 'error'
        ? new Error('Original raw provider fixture failure')
        : new DOMException('Independent raw provider fixture failure', 'AbortError');
    const cancelled = rawEmbedding();
    const failed = rawEmbedding(genuine);
    const calls = [cancelled, failed].map((raw) =>
      Promise.resolve(lifetime.embedding(raw.model).doEmbed({ values: ['recorded input'] })).catch(
        (cause: unknown) => cause
      )
    );
    try {
      expect(await Promise.all([cancelled.entered.promise, failed.entered.promise])).toEqual([
        controller.signal,
        controller.signal,
      ]);
      controller.abort(new Error('Recorded owner cancellation'));
      let joined = false;
      const closing = lifetime.join().then(
        () => {
          joined = true;
          return;
        },
        (cause: unknown) => {
          joined = true;
          return cause;
        }
      );
      cancelled.release.resolve();
      const owned = await calls[0];
      expect(lifetime.ownsCancellation(owned)).toBe(true);
      await setImmediate();
      expect(joined).toBe(false);
      expect(failed.retired()).toBe(false);
      failed.release.resolve();
      expect(await calls[1]).toBe(genuine);
      const mixed = new AggregateError([owned, genuine], 'Recorded aggregate membership');
      expect(lifetime.ownsCancellation(mixed)).toBe(false);
      const outcome = await closing;
      if (!(outcome instanceof AggregateError)) {
        throw new Error('The original provider cleanup failure is absent');
      }
      expect(outcome.errors).toEqual([genuine]);
      expect(outcome.errors[0]).toBe(genuine);
      expect(await lifetime.join().catch((cause: unknown) => cause)).toBe(outcome);
      expect(cancelled.retired() && failed.retired()).toBe(true);
    } finally {
      cancelled.release.resolve();
      failed.release.resolve();
      await Promise.allSettled(calls);
      await lifetime.join().catch(() => undefined);
    }
  }
);

test.each(['same-reason', 'receipt'] as const)(
  'HostMemory retains the original mixed %s failure on repeated close',
  async (kind) => {
    const storage = new InMemoryStore({ id: randomUUID() });
    await storage.init();
    const controller = new AbortController();
    const raw = rawEmbedding();
    let wrapped: MastraEmbeddingModel<string> | undefined;
    let failure: unknown;
    const owner = new HostMemory(
      {
        resourceId: randomUUID(),
        runId: randomUUID(),
        signal: controller.signal,
        threadId: randomUUID(),
      },
      {
        createNativeMemory: (native) => {
          if (!native.embedder || typeof native.embedder === 'string') {
            throw new Error('Captured wrapped embedding capability is absent');
          }
          wrapped = native.embedder;
          return new Memory(native);
        },
        joinNativeLifetime: async () => {
          if (kind === 'same-reason') {
            throw controller.signal.reason;
          }
        },
        native: {
          embedder: raw.model,
          options: {
            observationalMemory: false,
            semanticRecall: false,
            workingMemory: { enabled: false },
          },
          storage,
        },
        recordObserverUsage: async () => {
          throw failure;
        },
        recordPrompt: async () => undefined,
      }
    );
    try {
      if (!wrapped) {
        throw new Error('Actual wrapped embedding capability was not captured');
      }
      const call = Promise.resolve(wrapped.doEmbed({ values: ['recorded input'] })).catch(
        (cause: unknown) => cause
      );
      await raw.entered.promise;
      controller.abort(new Error('Recorded owner cancellation'));
      raw.release.resolve();
      const owned = await call;
      const genuine =
        kind === 'same-reason'
          ? controller.signal.reason
          : new Error('Original genuine fixture failure');
      failure = new AggregateError([owned, genuine], 'Recorded aggregate membership');
      const recorded = streamText({
        maxRetries: 0,
        model: scriptedModel(),
        prompt: 'Recorded usage control',
      });
      await recorded.consumeStream();
      await expect(
        owner.recordObserverUsage({
          kind: 'observation',
          modelId: raw.model.modelId,
          usage: await recorded.usage,
        })
      ).rejects.toBe(failure);
      for (const closing of [owner.close(), owner.close()]) {
        const outcome = await closing.catch((cause: unknown) => cause);
        expect(outcome).toBeInstanceOf(AggregateError);
        if (!(outcome instanceof AggregateError)) {
          throw new Error('Original cleanup aggregate is absent');
        }
        expect(outcome.errors).toContain(failure);
        expect((failure as AggregateError).errors[1]).toBe(genuine);
        if (kind === 'same-reason') {
          expect(outcome.errors).toContain(genuine);
        }
      }
    } finally {
      raw.release.resolve();
      await owner.close().catch(() => undefined);
      await storage.close();
    }
  }
);
