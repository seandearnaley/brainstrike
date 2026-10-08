import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { deterministicEmbedding } from './fixtures/memory-vector-host.js';
import { observationHostLifecycle } from './fixtures/observation-host-lifecycle.js';
import { RECORDED_VECTOR_PROFILE } from './fixtures/recorded-memory-vector-port.js';

const fetch = vi.fn(async () => {
  throw new Error('Observation lifecycle qualification makes no provider requests');
});
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => {
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
      const signal = f.contexts.at(-1)?.signal;
      expect(signal).toBeDefined();
      expect(f.embeddingSignals).toEqual([signal]);
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
        'Single actual observation tail receipt:',
        JSON.stringify({ boundary, operation, outcome, writes: f.writes })
      );
      expect(outcome.status).toBe('fulfilled');
      expect(boundary === 'inference' ? f.inferenceRetired() : f.vectorRetired()).toBe(true);
      expect(f.writes).toHaveLength(boundary === 'vector' ? 1 : 0);
      if (boundary === 'vector') {
        expect(f.writes[0]?.afterAbort).toBe(true);
        expect(f.writes[0]?.ids.length).toBeGreaterThan(0);
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
        const query = {
          limit: 10,
          profile: RECORDED_VECTOR_PROFILE,
          scope: { resourceId: f.resourceId, rootId: f.root, threadId: ids.threadId },
          vector: deterministicEmbedding('Paris held vector observation.'),
        };
        const before = await indexer.queryStateObservationVectors(query);
        await setImmediate();
        expect(await indexer.queryStateObservationVectors(query)).toEqual(before);
        if (operation === 'deletion') {
          expect(await f.store?.threads()).not.toContain(ids.threadId);
        } else {
          expect(before.map(({ id }) => id)).toEqual(f.writes[0]?.ids);
        }
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
