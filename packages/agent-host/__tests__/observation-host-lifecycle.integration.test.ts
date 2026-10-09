import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
import type { MastraDBMessage } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { ObservationalMemory, TokenCounter } from '@mastra/memory/processors';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { deterministicEmbedding } from './fixtures/memory-vector-host.js';
import {
  observationHostLifecycle,
  recordedObservationModel,
} from './fixtures/observation-host-lifecycle.js';
import { RECORDED_VECTOR_PROFILE } from './fixtures/recorded-memory-vector-port.js';

const fetch = vi.fn(async () => {
  throw new Error('Observation lifecycle qualification makes no provider requests');
});
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

function watched<Value>(promise: Promise<Value>) {
  let settled = false;
  const result = promise.then(
    (value) => {
      settled = true;
      return { status: 'fulfilled' as const, value };
    },
    (reason: unknown) => {
      settled = true;
      return { reason, status: 'rejected' as const };
    }
  );
  return { result, settled: () => settled };
}

test('resource observer attribution invariant preserves each selected bucket thread', async () => {
  const identities = (messages: readonly MastraDBMessage[]) =>
    messages.map(({ id, threadId, role }) => ({ id, role, threadId }));
  const contexts: unknown[] = [];
  const observations: {
    owner: string;
    messages: ReturnType<typeof identities>;
    live: ReturnType<typeof identities>;
  }[] = [];
  const buckets: {
    messages: ReturnType<typeof identities>;
    tokens: number;
    ownerOnlyTokens: number;
  }[] = [];
  const selected: { threadId: string | undefined; messages: ReturnType<typeof identities> }[] = [];
  let active = false;
  const getContext = Memory.prototype.getContext;
  const observe = ObservationalMemory.prototype.observe;
  const count = TokenCounter.prototype.countMessagesAsync;
  const contextSpy = vi.spyOn(Memory.prototype, 'getContext').mockImplementation(async function (
    this: Memory,
    options
  ) {
    const context = await getContext.call(this, options);
    if (active) {
      contexts.push({ messages: identities(context.messages), owner: options.threadId });
    }
    return context;
  });
  const observationSpy = vi
    .spyOn(ObservationalMemory.prototype, 'observe')
    .mockImplementation(function (this: ObservationalMemory, options) {
      if (active) {
        observations.push({
          live: identities(options.messageList?.get.all.db() ?? []),
          messages: identities(options.messages ?? []),
          owner: options.threadId,
        });
      }
      return observe.call(this, options);
    });
  const countSpy = vi
    .spyOn(TokenCounter.prototype, 'countMessagesAsync')
    .mockImplementation(async function (this: TokenCounter, messages) {
      const strategy =
        active &&
        new Error('Native resource prepare trace').stack?.includes(
          'ResourceScopedObservationStrategy.prepare'
        );
      const tokens = await count.call(this, messages);
      if (strategy) {
        const owner = observations.at(-1)?.owner;
        const ownerOnlyTokens = await count.call(
          this,
          messages.filter((message) => message.threadId === owner)
        );
        buckets.push({ messages: identities(messages), ownerOnlyTokens, tokens });
      }
      return tokens;
    });
  const f = await observationHostLifecycle('both', ({ messages, threadId }) => {
    if (active) {
      selected.push({ messages: identities(messages), threadId });
    }
  });
  try {
    active = true;
    await f.start();
    await f.enteredInference.promise;
    const snapshot = await f.store?.memory({ operation: 'read', resourceId: f.resourceId });
    const receipt = {
      getContext: contexts,
      nativePrepareTokenCounts: buckets,
      observeOptionsAndLiveList: observations,
      persisted: snapshot?.entities
        .filter(({ kind }) => kind === 'observation')
        .map(({ id, threadId, payload }) => ({
          activeObservations: payload['activeObservations'],
          id,
          threadId,
        })),
      profile: RECORDED_VECTOR_PROFILE,
      resourceId: f.resourceId,
      selectedObserverBuckets: selected,
      threads: f.threads,
      threshold: f.observationThreshold(),
    };
    console.error('Resource observer attribution trace:', JSON.stringify(receipt));
    expect(contexts.length).toBeGreaterThan(0);
    expect(observations.length).toBeGreaterThan(0);
    expect(buckets).toHaveLength(2);
    expect(new Set(selected.map(({ threadId }) => threadId))).toEqual(new Set(f.threads));
    for (const bucket of selected) {
      expect(bucket.messages.every((message) => message.threadId === bucket.threadId)).toBe(true);
    }
  } finally {
    await f.close();
    contextSpy.mockRestore();
    observationSpy.mockRestore();
    countSpy.mockRestore();
  }
});

const require = createRequire(import.meta.url);
const common = require('@mastra/memory/processors') as typeof import('@mastra/memory/processors');
test.each([
  { Engine: ObservationalMemory, label: 'ESM' },
  { Engine: common.ObservationalMemory, label: 'CJS' },
])(
  '$label public native resource overlay preserves sibling affinity and unthreaded current input',
  async ({ Engine }) => {
    const storage = new InMemoryStore({ id: randomUUID() });
    await storage.init();
    const domain = await storage.getStore('memory');
    if (!domain) {
      throw new Error('Public native memory domain is absent');
    }
    const resourceId = randomUUID();
    const owner = randomUUID();
    const sibling = randomUUID();
    const createdAt = new Date('2026-10-06T00:00:00Z');
    const messages: MastraDBMessage[] = [owner, sibling].map((threadId) => ({
      content: { format: 2, parts: [{ text: 'Paris weather. '.repeat(60), type: 'text' }] },
      createdAt,
      id: randomUUID(),
      resourceId,
      role: 'user',
      threadId,
    }));
    const unthreaded: MastraDBMessage = {
      content: { format: 2, parts: [{ text: 'Continue Paris.', type: 'text' }] },
      createdAt: new Date(createdAt.getTime() + 1),
      id: randomUUID(),
      resourceId,
      role: 'user',
    };
    const counter = new TokenCounter();
    const threshold =
      Math.max(
        ...(await Promise.all(messages.map((message) => counter.countMessagesAsync([message]))))
      ) + 100;
    const selected = new Map<string, readonly MastraDBMessage[]>();
    const engine = new Engine({
      hooks: {
        beforeObservation: ({ messages: input, threadId }) => {
          if (!threadId) {
            throw new Error('Native resource observer did not identify its selected bucket');
          }
          selected.set(threadId, structuredClone(input));
        },
      },
      model: recordedObservationModel([owner, sibling]),
      observation: { bufferOnIdle: false, bufferTokens: false, messageTokens: threshold },
      reflection: { observationTokens: 50_000 },
      scope: 'resource',
      storage: domain,
    });
    try {
      for (const id of [owner, sibling]) {
        await domain.saveThread({
          thread: { createdAt, id, metadata: {}, resourceId, updatedAt: createdAt },
        });
      }
      await domain.saveMessages({ messages });
      const result = await engine.observe({
        messages: [...messages, unthreaded],
        resourceId,
        threadId: owner,
      });
      expect(result.observed).toBe(true);
      expect(selected.get(owner)?.map(({ id }) => id)).toEqual([messages[0]?.id, unthreaded.id]);
      expect(selected.get(sibling)?.map(({ id }) => id)).toEqual([messages[1]?.id]);
      expect(selected.get(owner)?.find(({ id }) => id === unthreaded.id)?.threadId).toBeUndefined();
      expect(
        (await domain.listMessages({ perPage: false, threadId: sibling })).messages.map(
          ({ id }) => id
        )
      ).toEqual([messages[1]?.id]);
    } finally {
      await engine.settled();
      await storage.close();
    }
  }
);

test.each([
  { boundary: 'inference', operation: 'Stop' },
  { boundary: 'vector', operation: 'Stop' },
  { boundary: 'inference', operation: 'deletion' },
  { boundary: 'vector', operation: 'deletion' },
  { boundary: 'inference', operation: 'Root close' },
  { boundary: 'vector', operation: 'Root close' },
] as const)(
  'single actual factory $operation joins its native $boundary tail',
  async ({ boundary, operation }) => {
    const f = await observationHostLifecycle(boundary);
    let retirement: ReturnType<typeof watched<unknown>> | undefined;
    try {
      const ids = await f.start();
      await (boundary === 'inference' ? f.enteredInference.promise : f.enteredVector.promise);
      await f.unheldCompleted.promise;
      const signal = f.contexts.at(-1)?.signal;
      expect(signal).toBeDefined();
      expect(f.embeddingSignals).toEqual([signal, signal]);
      expect(f.prepares).toHaveLength(2);
      retirement = watched<unknown>(
        operation === 'Stop'
          ? f.client.request('run/stop', { commandId: randomUUID(), ...ids })
          : operation === 'deletion'
            ? f.core.deleteThread({ threadId: ids.threadId })
            : f.host.close()
      );
      expect(await f.aborted.promise).toBe(signal);
      await setImmediate();
      expect(retirement.settled()).toBe(false);
      await expect(StateStore.open(f.root)).rejects.toBeInstanceOf(RootLockedError);
      f.inferenceRelease.resolve();
      f.vectorRelease.resolve();
      const outcome = await retirement.result;
      console.error(
        'Actual observation boundary tails receipt:',
        JSON.stringify({ boundary, operation, outcome, writes: f.writes })
      );
      expect(outcome.status).toBe('fulfilled');
      expect(boundary === 'inference' ? f.inferenceRetired() : f.vectorRetired()).toBe(true);
      expect(f.writes).toHaveLength(boundary === 'vector' ? 2 : 1);
      expect(f.writes.filter(({ afterAbort }) => !afterAbort)).toHaveLength(1);
      const lateWrites = f.writes.filter(({ afterAbort }) => afterAbort);
      expect(lateWrites).toHaveLength(boundary === 'vector' ? 1 : 0);
      for (const write of lateWrites) {
        expect(write.ids.length).toBeGreaterThan(0);
      }
      if (operation === 'deletion') {
        expect(await f.store?.threads()).not.toContain(ids.threadId);
      }
      if (operation === 'Stop') {
        expect(outcome).toEqual({ status: 'fulfilled', value: { outcome: 'stopped' } });
      }
      const writes = structuredClone(f.writes);
      await f.host.close();
      expect(RootLock.inspect(f.root)?.owner.released).toBe(true);
      const reopened = await StateStore.open(f.root);
      try {
        const before = await reopened.memory({ operation: 'read', resourceId: f.resourceId });
        await setImmediate();
        expect(f.writes).toEqual(writes);
        expect(await reopened.memory({ operation: 'read', resourceId: f.resourceId })).toEqual(
          before
        );
      } finally {
        await reopened.close();
      }
    } finally {
      f.inferenceRelease.resolve();
      f.vectorRelease.resolve();
      await retirement?.result;
      await f.close();
    }
  }
);

test.each(['Stop', 'deletion', 'Root close'] as const)(
  'actual factory-wrapped Core %s joins independent native observation inference and late vector tails',
  async (operation) => {
    const f = await observationHostLifecycle();
    let retirement: ReturnType<typeof watched<unknown>> | undefined;
    try {
      const ids = await f.start();
      const [inferenceSignal] = await Promise.all([
        f.enteredInference.promise,
        f.enteredVector.promise,
      ]);
      const context = f.contexts.at(-1);
      expect(inferenceSignal).toBe(context?.signal);
      expect(inferenceSignal?.aborted).toBe(false);
      expect(f.prepares.length).toBe(2);
      expect(f.inferenceRetired()).toBe(false);
      expect(f.vectorRetired()).toBe(false);
      retirement = watched<unknown>(
        operation === 'Stop'
          ? f.client.request('run/stop', { commandId: randomUUID(), ...ids })
          : operation === 'deletion'
            ? f.core.deleteThread({ threadId: ids.threadId })
            : f.host.close()
      );
      expect(await f.aborted.promise).toBe(inferenceSignal);
      expect(inferenceSignal?.aborted).toBe(true);
      await setImmediate();
      expect(retirement.settled()).toBe(false);
      expect(RootLock.inspect(f.root)).toBeDefined();
      await expect(StateStore.open(f.root)).rejects.toBeInstanceOf(RootLockedError);

      // Only the already-admitted vector tail is released. Its real writer call
      // completes after cancellation; the unrelated raw inference still owns Root.
      f.vectorRelease.resolve();
      const indexer = f.indexer;
      if (!indexer) {
        throw new Error('The acquired observation writer is absent');
      }
      await f.vectorCompleted.promise;
      await setImmediate();
      expect(retirement.settled()).toBe(false);
      expect(f.inferenceRetired()).toBe(false);
      await expect(StateStore.open(f.root)).rejects.toBeInstanceOf(RootLockedError);
      f.inferenceRelease.resolve();
      const outcome = await retirement.result;
      console.error(
        'Actual observation retirement receipt:',
        JSON.stringify({
          inferenceRetired: f.inferenceRetired(),
          operation,
          outcome,
          physicalWrites: f.writes,
          preparedCommittedGroups: f.prepares,
          resourceId: f.resourceId,
          threads: f.threads,
          vectorRetired: f.vectorRetired(),
        })
      );
      expect(outcome.status).toBe('fulfilled');
      expect(f.inferenceRetired()).toBe(true);
      expect(f.vectorRetired()).toBe(true);
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]?.afterAbort).toBe(true);
      expect(f.writes[0]?.ids.length).toBeGreaterThan(0);
      if (operation === 'Stop') {
        expect(outcome).toEqual({ status: 'fulfilled', value: { outcome: 'stopped' } });
      }
      if (operation !== 'Root close') {
        const survivingThread = f.threads[1];
        if (!survivingThread) {
          throw new Error('Committed sibling thread is absent');
        }
        const query = {
          limit: 10,
          profile: RECORDED_VECTOR_PROFILE,
          scope: { resourceId: f.resourceId, rootId: f.root, threadId: ids.threadId },
          vector: deterministicEmbedding('Paris held vector observation.'),
        };
        if (operation === 'deletion') {
          await expect(indexer.queryStateObservationVectors(query)).rejects.toMatchObject({
            code: 'thread-not-authorized',
          });
          query.scope.threadId = survivingThread;
        }
        const before = await indexer.queryStateObservationVectors(query);
        await setImmediate();
        expect(await indexer.queryStateObservationVectors(query)).toEqual(before);
        if (operation === 'deletion') {
          expect(await f.store?.threads()).not.toContain(ids.threadId);
          expect(await f.store?.threads()).toContain(survivingThread);
        }
        // The written group belongs to the surviving sibling: deleting the other
        // thread detaches only that thread's sections, so this vector stays.
        expect(before.map(({ id }) => id)).toEqual(f.writes[0]?.ids);
        await f.host.close();
      }
      expect(RootLock.inspect(f.root)?.owner.released).toBe(true);
      const reopened = await StateStore.open(f.root);
      try {
        const before = await reopened.memory({ operation: 'read', resourceId: f.resourceId });
        await setImmediate();
        expect(await reopened.memory({ operation: 'read', resourceId: f.resourceId })).toEqual(
          before
        );
      } finally {
        await reopened.close();
      }
    } finally {
      f.vectorRelease.resolve();
      f.inferenceRelease.resolve();
      await retirement?.result;
      await f.close();
    }
  }
);

test.each(['Stop', 'deletion', 'Root close'] as const)(
  'actual two-inference Core %s joins both original raw calls before acknowledgement',
  async (operation) => {
    const f = await observationHostLifecycle('two-inference');
    let retirement: ReturnType<typeof watched<unknown>> | undefined;
    try {
      const ids = await f.start();
      const signal = await f.enteredInference.promise;
      expect(signal).toBe(f.contexts.at(-1)?.signal);
      expect(f.embeddingSignals).toEqual([signal, signal]);
      expect(f.inferenceCalls).toHaveLength(2);
      expect(f.inferenceCalls.every((call) => call.signal === signal && !call.retired)).toBe(true);
      expect(new Set(f.prepares).size).toBe(2);
      retirement = watched<unknown>(
        operation === 'Stop'
          ? f.client.request('run/stop', { commandId: randomUUID(), ...ids })
          : operation === 'deletion'
            ? f.core.deleteThread({ threadId: ids.threadId })
            : f.host.close()
      );
      expect(await f.aborted.promise).toBe(signal);
      await setImmediate();
      expect(retirement.settled()).toBe(false);
      await expect(StateStore.open(f.root)).rejects.toBeInstanceOf(RootLockedError);
      const [firstRelease, secondRelease] = f.inferenceReleases;
      const [firstCompleted, secondCompleted] = f.inferenceCompleted;
      if (!(firstRelease && secondRelease && firstCompleted && secondCompleted)) {
        throw new Error('Two independently admitted inference controls are required');
      }
      firstRelease.resolve();
      await firstCompleted.promise;
      await setImmediate();
      expect(f.inferenceCalls.map(({ retired }) => retired)).toEqual([true, false]);
      expect(retirement.settled()).toBe(false);
      await expect(StateStore.open(f.root)).rejects.toBeInstanceOf(RootLockedError);
      secondRelease.resolve();
      await secondCompleted.promise;
      const outcome = await retirement.result;
      console.error(
        'Actual two-inference retirement receipt:',
        JSON.stringify({
          operation,
          outcome,
          prepares: f.prepares,
          rawCalls: f.inferenceCalls.map(({ afterAbort, retired, values, signal: original }) => ({
            afterAbort,
            originalSignal: original === signal,
            retired,
            values,
          })),
          root: f.root,
          writes: f.writes,
        })
      );
      expect(outcome.status).toBe('fulfilled');
      expect(f.inferenceCalls.every((call) => call.retired && call.afterAbort)).toBe(true);
      expect(f.writes).toEqual([]);
      if (operation === 'Stop') {
        expect(outcome).toEqual({ status: 'fulfilled', value: { outcome: 'stopped' } });
      }
      if (operation === 'deletion') {
        expect(outcome).toEqual({ status: 'fulfilled', value: { deleted: true } });
        expect(await f.store?.threads()).not.toContain(ids.threadId);
      }
      await f.host.close();
      expect(RootLock.inspect(f.root)?.owner.released).toBe(true);
      const reopened = await StateStore.open(f.root);
      try {
        const before = await reopened.memory({ operation: 'read', resourceId: f.resourceId });
        await setImmediate();
        expect(f.inferenceCalls.every((call) => call.retired)).toBe(true);
        expect(f.writes).toEqual([]);
        expect(await reopened.memory({ operation: 'read', resourceId: f.resourceId })).toEqual(
          before
        );
      } finally {
        await reopened.close();
      }
    } finally {
      for (const release of f.inferenceReleases) {
        release.resolve();
      }
      await retirement?.result;
      await f.close();
    }
  }
);
