import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import type { StateMessageUpsert, StateMessageVectorPort } from '@brainstrike/indexer';
import { RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { HostResults } from '../src/protocol.js';
import { captureHostFailureDiagnostics } from './fixtures/host-failure-diagnostics.js';
import {
  deterministicEmbedding,
  failureReceipt,
  memoryVectorHost,
} from './fixtures/memory-vector-host.js';
import { memoryVectorWriterHold } from './fixtures/memory-vector-writer-hold.js';
import { RECORDED_VECTOR_PROFILE } from './fixtures/recorded-memory-vector-port.js';

const fetch = vi.fn(async () => {
  throw new Error('Lifecycle packet makes no provider requests');
});
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => {
  expect(fetch.mock.calls.length).toBe(0);
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

type Host = Awaited<ReturnType<typeof memoryVectorHost>>;

async function qualification(body: () => Promise<void>, cleanup: () => Promise<void>) {
  const failures: unknown[] = [];
  const [primary] = await Promise.allSettled([Promise.resolve().then(body)]);
  if (primary?.status === 'rejected') {
    failures.push(primary.reason);
  }
  const [retirement] = await Promise.allSettled([Promise.resolve().then(cleanup)]);
  if (retirement?.status === 'rejected') {
    console.error('Lifecycle cleanup receipt:', JSON.stringify(failureReceipt(retirement.reason)));
    failures.push(retirement.reason);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Qualification and cleanup failed');
  }
}

async function start(host: Host) {
  const { threadId } = await host.core.startThread({ commandId: randomUUID() });
  const { runId } = await host.core.startRun({
    commandId: randomUUID(),
    modelId: 'recorded-sdk-fixture',
    prompt: 'Paris lifecycle source.',
    threadId,
  });
  return { runId, threadId };
}

function observeClose(host: Host) {
  const owner = host.owners[0];
  if (!owner) {
    throw new Error('Actual Memory run owner has not opened');
  }
  const entered = Promise.withResolvers<void>();
  const close = owner.close.bind(owner);
  vi.spyOn(owner, 'close').mockImplementation(() => {
    entered.resolve();
    return close();
  });
  return entered.promise;
}

function query(host: Host, threadId: string) {
  return {
    limit: 10,
    profile: RECORDED_VECTOR_PROFILE,
    scope: { resourceId: host.resourceId, rootId: host.root, threadId },
    vector: deterministicEmbedding('Host run completed.'),
  };
}

test('actual Core Stop cancels and joins withheld concrete save embedding before acknowledgement', async () => {
  const entered = Promise.withResolvers<AbortSignal | undefined>();
  const release = Promise.withResolvers<void>();
  let retired = false;
  const host = await memoryVectorHost({
    beforeEmbedding: async (values, signal) => {
      if (values.includes('Host run completed.')) {
        entered.resolve(signal);
        await release.promise;
        retired = true;
      }
    },
    realIndexer: true,
    semanticScope: 'thread',
  });
  let stop: ReturnType<typeof watched<unknown>> | undefined;
  await qualification(
    async () => {
      const ids = await start(host);
      const received = await entered.promise;
      const closeEntered = observeClose(host);
      stop = watched(host.core.stop({ commandId: randomUUID(), ...ids }));
      await closeEntered;
      expect(host.contexts[0]?.signal.aborted).toBe(true);
      expect(retired).toBe(false);
      await expect(StateStore.open(host.root)).rejects.toBeInstanceOf(RootLockedError);
      expect(stop.settled()).toBe(false);
      expect(host.retained()).toBe(1);
      expect(
        (await host.core.read(ids.threadId, 0)).some((row) => row.event.type === 'run.finished')
      ).toBe(false);
      console.error(
        'Concrete embedding cancellation receipt:',
        JSON.stringify({
          nativeSignalAborted: received?.aborted,
          nativeSignalPresent: received !== undefined,
          retained: host.retained(),
          stopSettledBeforeRetirement: stop.settled(),
        })
      );
      expect.soft(received?.aborted).toBe(true);
      release.resolve();
      const result = await stop.result;
      console.error(
        'Concrete embedding Stop outcome:',
        JSON.stringify(result.status === 'rejected' ? failureReceipt(result.reason) : result)
      );
      expect(result).toEqual({ status: 'fulfilled', value: { outcome: 'stopped' } });
      expect(host.retained()).toBe(0);
      expect(await host.indexer?.queryStateMessageVectors(query(host, ids.threadId))).toEqual([]);
    },
    async () => {
      release.resolve();
      await stop?.result;
      await host.close();
    }
  );
});

test.each([
  { boundary: 'inference', operation: 'Stop' },
  { boundary: 'writer', operation: 'Stop' },
  { boundary: 'inference', operation: 'deletion' },
  { boundary: 'writer', operation: 'deletion' },
] as const)(
  'actual Core $operation joins an independent $boundary failure after cancellation and releases the run',
  async ({ boundary, operation }) => {
    const diagnostics = captureHostFailureDiagnostics();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const inferenceFailure = new DOMException(
      'Independent embedding inference failure',
      'AbortError'
    );
    let retired = false;
    const host = await memoryVectorHost({
      beforeEmbedding: async (values) => {
        if (boundary === 'inference' && values.includes('Host run completed.')) {
          entered.resolve();
          await release.promise;
          retired = true;
          throw inferenceFailure;
        }
      },
      borrowVectorPort: (port, context): StateMessageVectorPort => ({
        prepareStateMessageVectors: (input) => port.prepareStateMessageVectors(input),
        purgeStateMessageVectors: (input) => port.purgeStateMessageVectors(input),
        queryStateMessageVectors: (input) => port.queryStateMessageVectors(input),
        upsertStateMessageVectors: async (input) => {
          const result = await port.upsertStateMessageVectors(input);
          if (boundary === 'writer') {
            entered.resolve();
            await release.promise;
            retired = true;
            // Even the identical reason object is an independent writer
            // rejection here; only the provider enclosure mints cancellation.
            throw context.signal.reason;
          }
          return result;
        },
      }),
      realIndexer: true,
      semanticScope: 'thread',
    });
    let stop: ReturnType<typeof watched<unknown>> | undefined;
    try {
      const ids = await start(host);
      await entered.promise;
      const closeEntered = observeClose(host);
      stop = watched<unknown>(
        operation === 'Stop'
          ? host.core.stop({ commandId: randomUUID(), ...ids })
          : host.core.deleteThread({ threadId: ids.threadId })
      );
      await closeEntered;
      expect(host.contexts[0]?.signal.aborted).toBe(true);
      expect(retired).toBe(false);
      expect(stop.settled()).toBe(false);
      expect(host.retained()).toBe(1);
      await expect(StateStore.open(host.root)).rejects.toBeInstanceOf(RootLockedError);
      release.resolve();
      const result = await stop.result;
      expect(retired).toBe(true);
      // The independent failure joined physically: it is the run's visible
      // outcome, and the run, its thread and Root are released.
      expect(result).toEqual({
        status: 'fulfilled',
        value:
          operation === 'Stop'
            ? { outcome: 'stopped' }
            : { deleted: true, threadIds: [ids.threadId] },
      });
      expect(host.retained()).toBe(0);
      if (operation === 'Stop') {
        const finished = (await host.core.read(ids.threadId, 0))
          .map((row) => row.event)
          .find((event) => event.type === 'run.finished');
        expect(finished).toMatchObject({ outcome: 'stopped', type: 'run.finished' });
        const detail = finished?.type === 'run.finished' ? finished.detail : undefined;
        expect(detail).toBe(INTERNAL_FAULT.message);
        diagnostics.expectCause('Memory save failed');
        diagnostics.expectCause(
          boundary === 'inference' ? inferenceFailure.message : 'Run stopped by user'
        );
      } else {
        expect(await host.store.threads()).not.toContain(ids.threadId);
      }
      await expect(host.core.close()).resolves.toBeUndefined();
    } finally {
      release.resolve();
      await stop?.result;
      await host.close();
    }
  }
);

test.skipIf(process.platform !== 'linux').each(['query', 'write'] as const)(
  'actual Core Stop joins withheld indexer %s before explicit component retirement and reopen',
  async (phase) => {
    let held: Awaited<ReturnType<typeof memoryVectorWriterHold>> | undefined;
    let saved: StateMessageUpsert | undefined;
    const host = await memoryVectorHost({
      borrowVectorPort: (port): StateMessageVectorPort => ({
        prepareStateMessageVectors: (input) => port.prepareStateMessageVectors(input),
        purgeStateMessageVectors: (input) => port.purgeStateMessageVectors(input),
        queryStateMessageVectors: async (input) => {
          if (phase === 'query') {
            await held?.arm();
          }
          return port.queryStateMessageVectors(input);
        },
        upsertStateMessageVectors: async (input) => {
          if (phase === 'write') {
            saved = input;
            await held?.arm();
          }
          return port.upsertStateMessageVectors(input);
        },
      }),
      realIndexer: true,
      semanticScope: 'thread',
      stateProjectionModule: new URL('./fixtures/memory-vector-core-producer.mjs', import.meta.url)
        .href,
    });
    held = await memoryVectorWriterHold(host.root);
    let stop: ReturnType<typeof watched<unknown>> | undefined;
    await qualification(
      async () => {
        const ids = await start(host);
        await held?.entered;
        const closeEntered = observeClose(host);
        stop = watched(host.core.stop({ commandId: randomUUID(), ...ids }));
        await closeEntered;
        await expect(StateStore.open(host.root)).rejects.toBeInstanceOf(RootLockedError);
        expect(stop.settled()).toBe(false);
        expect(host.retained()).toBe(1);
        expect(
          (await host.core.read(ids.threadId, 0)).some((row) => row.event.type === 'run.finished')
        ).toBe(false);
        expect(RootLock.inspect(host.root)).toBeDefined();
        await held?.release();
        const result = await stop.result;
        console.error(
          'Actual writer Stop receipt:',
          JSON.stringify({
            outcome: result.status === 'rejected' ? failureReceipt(result.reason) : result,
            phase,
          })
        );
        expect(result).toEqual({ status: 'fulfilled', value: { outcome: 'stopped' } });
        expect(host.retained()).toBe(0);
        await host.core.close();
        if (phase === 'query') {
          await host.store.deleteThread(ids.threadId);
        } else {
          await host.store.reset();
          for (const file of ['state.db', 'index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) {
            expect(existsSync(join(host.root, file))).toBe(false);
          }
        }
        await held?.close();
        await host.reopen(phase === 'write');
        expect(await host.store.threads()).not.toContain(ids.threadId);
        await expect(
          host.indexer?.queryStateMessageVectors(query(host, ids.threadId))
        ).rejects.toMatchObject({ code: 'thread-not-authorized' });
        if (saved) {
          await expect(host.indexer?.upsertStateMessageVectors(saved)).rejects.toThrow();
          expect(await host.store.threads()).not.toContain(ids.threadId);
        }
      },
      async () => {
        await held?.close();
        await stop?.result;
        await host.close();
      }
    );
  }
);

test('Root deletion retires active Core embedding before canonical and native data are erased', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let retired = false;
  const host = await memoryVectorHost({
    beforeEmbedding: async (values) => {
      if (values.includes('Host run completed.')) {
        entered.resolve();
        await release.promise;
        retired = true;
      }
    },
    realIndexer: true,
    semanticScope: 'thread',
  });
  let deletion: ReturnType<typeof watched<HostResults['thread/delete']>> | undefined;
  await qualification(
    async () => {
      const ids = await start(host);
      await entered.promise;
      const closeEntered = observeClose(host);
      const raw = await host.store.read(ids.threadId);
      deletion = watched(host.core.deleteThread({ threadId: ids.threadId }));
      await closeEntered;
      expect(host.contexts[0]?.signal.aborted).toBe(true);
      expect(retired).toBe(false);
      expect(deletion.settled()).toBe(false);
      expect(await host.store.read(ids.threadId)).toEqual(raw);
      await expect(StateStore.open(host.root)).rejects.toBeInstanceOf(RootLockedError);
      release.resolve();
      expect(await deletion.result).toEqual({
        status: 'fulfilled',
        value: { deleted: true, threadIds: [ids.threadId] },
      });
      console.error(
        'Joined Root deletion receipt:',
        JSON.stringify({
          coreRetained: host.retained(),
          deletedThreadPresent: (await host.store.threads()).includes(ids.threadId),
          embeddingRetired: retired,
          rootSignalAborted: host.contexts[0]?.signal.aborted,
        })
      );
      expect(retired).toBe(true);
      expect(host.retained()).toBe(0);
      expect(await host.store.threads()).not.toContain(ids.threadId);
      expect(host.core.listThreads()).not.toContainEqual({ threadId: ids.threadId });
      await expect(
        host.indexer?.queryStateMessageVectors(query(host, ids.threadId))
      ).rejects.toMatchObject({ code: 'thread-not-authorized' });
      await host.reopen();
      expect(await host.store.threads()).not.toContain(ids.threadId);
      expect(host.core.listThreads()).not.toContainEqual({ threadId: ids.threadId });
    },
    async () => {
      release.resolve();
      await deletion?.result;
      await host.close();
    }
  );
});
