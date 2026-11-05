// BST-2398: Mastra's memory calculation runs on its own worker, so the writer serves while a calculation is in flight,
// and a calculation's delta commits only against the revision it read. The calculator here is a test module that
// holds a calculation until the test releases it over a BroadcastChannel, which reaches every thread of the process.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BroadcastChannel } from 'node:worker_threads';
import { afterEach, expect, test } from 'vitest';
import { MemoryCalculatorError } from '../src/memory-calculator.ts';
import type { MemoryJson, MemorySnapshot } from '../src/memory-types.ts';
import { StateStore } from '../src/state-store.ts';
import { cleanupDirs, freshDir } from './helpers/fs.ts';
import { TruthIndexer } from './helpers/truth-indexer.ts';

const resourceId = 'resource';
const channels: BroadcastChannel[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  for (const channel of channels.splice(0)) {
    channel.close();
  }
  cleanupDirs();
});

/**
 * A calculator module. `['hold', id]` announces `{ entered: id }` and waits for `{ release: id }`; `['crash']` ends
 * its worker. Each calculation appends its id to the resource's `items`.
 */
function calculatorModule(root: string, channelName: string): string {
  const path = join(root, 'calculator.mjs');
  writeFileSync(
    path,
    `const channel = new BroadcastChannel(${JSON.stringify(channelName)});
const waiting = new Map();
channel.onmessage = (event) => waiting.get(event.data.release)?.();
export async function calculateMemoryMutation(snapshot, request) {
  const [action, id] = request.arguments;
  if (action === 'crash') process.exit(3);
  if (action === 'hold') {
    const released = new Promise((resolve) => waiting.set(id, resolve));
    channel.postMessage({ entered: id });
    await released;
  }
  const resource = snapshot.entities.find((entity) => entity.kind === 'resource');
  const items = [...(resource?.payload.items ?? []), id];
  const entity = { id: request.resourceId, kind: 'resource', payload: { id: request.resourceId, items }, threadId: null };
  return { changes: [{ operation: 'put', entity }], value: snapshot.revision };
}
export const countObservationTokens = (text) => text.length;
`
  );
  return path;
}

interface Harness {
  readonly entered: (id: string) => Promise<void>;
  readonly release: (id: string) => void;
  readonly root: string;
  readonly store: StateStore;
}

async function open(tag: string, options: { indexer?: boolean } = {}): Promise<Harness> {
  const root = freshDir(tag);
  const channelName = `bst-2398-${root}`;
  const channel = new BroadcastChannel(channelName);
  channel.unref();
  channels.push(channel);
  const entered = new Map<string, PromiseWithResolvers<void>>();
  const entry = (id: string): PromiseWithResolvers<void> => {
    const known = entered.get(id) ?? Promise.withResolvers<void>();
    entered.set(id, known);
    return known;
  };
  channel.onmessage = (event) => {
    entry(String((event.data as { entered: string }).entered)).resolve();
  };
  const indexer = options.indexer ? new TruthIndexer(root) : undefined;
  const store = await StateStore.open(root, {
    ...(indexer ? { indexer } : {}),
    memoryCalculatorModule: calculatorModule(root, channelName),
  });
  closers.push(async () => {
    await store.close();
    indexer?.close();
  });
  return {
    entered: (id) => entry(id).promise,
    release: (id) => channel.postMessage({ release: id }),
    root,
    store,
  };
}

const native = (
  store: StateStore,
  args: readonly MemoryJson[],
  ownerThreadId?: string
): Promise<MemorySnapshot> =>
  store.memory({
    arguments: args,
    method: 'saveResource',
    operation: 'native',
    resourceId,
    ...(ownerThreadId === undefined ? {} : { ownerThreadId }),
  });

const items = async (store: StateStore): Promise<unknown> =>
  (await store.memory({ operation: 'read', resourceId })).entities.find(
    (entity) => entity.kind === 'resource'
  )?.payload['items'];

test('an append commits while a memory calculation is in flight', async () => {
  const { entered, release, store } = await open('calc-append');
  let calculated = false;
  const held = native(store, ['hold', 'a']).then((snapshot) => {
    calculated = true;
    return snapshot;
  });
  await entered('a');
  const [row] = await store.append([{ event: { type: 'probe' }, threadId: 'thread' }]);
  expect(row?.seq).toBe(1);
  expect(calculated).toBe(false);
  release('a');
  expect((await held).revision).toBe(1);
  expect(await items(store)).toEqual(['a']);
  expect((await store.read('thread')).map((r) => r.event.type)).toEqual(['probe']);
});

test("one resource's concurrent memory mutations each build on the last; none is lost", async () => {
  const { entered, release, store } = await open('calc-lane');
  const first = native(store, ['hold', 'a']);
  const second = native(store, ['hold', 'b']);
  await entered('a');
  release('a');
  await entered('b');
  release('b');
  expect((await first).value).toBe(0);
  expect((await second).value).toBe(1);
  expect(await items(store)).toEqual(['a', 'b']);
});

test("deleting one thread waits for another thread's calculation on the shared resource; both writes are kept", async () => {
  const { entered, release, store } = await open('calc-delete', { indexer: true });
  const deleted = 'deleted-thread';
  await store.append([{ event: { type: 'probe' }, threadId: deleted }]);
  const section = (id: string, text: string): string => `<thread id="${id}">\n${text}\n</thread>`;
  await store.memory({
    changes: [
      {
        entity: {
          id: deleted,
          kind: 'thread',
          payload: { id: deleted, resourceId },
          threadId: deleted,
        },
        operation: 'put',
      },
      {
        entity: {
          id: 'observation',
          kind: 'observation',
          payload: {
            activeObservations: `${section(deleted, 'erase me')}\n\n${section('other', 'keep me')}`,
            id: 'observation',
            observationTokenCount: 0,
            resourceId,
            threadId: null,
          },
          threadId: null,
        },
        operation: 'put',
      },
    ],
    expectedRevision: 0,
    operation: 'commit',
    resourceId,
  });
  const other = native(store, ['hold', 'b']);
  await entered('b');
  let deletionDone = false;
  const deletion = store.deleteThread(deleted).then(() => {
    deletionDone = true;
  });
  // The run log is not held by either.
  expect(await store.append([{ event: { type: 'probe' }, threadId: 'other' }])).toHaveLength(1);
  expect(deletionDone).toBe(false);
  release('b');
  // Admitted first, committed first: the deletion then erases on top of it.
  expect((await other).revision).toBe(2);
  await deletion;
  const { entities, revision } = await store.memory({ operation: 'read', resourceId });
  expect(revision).toBe(3);
  const kept = section('other', 'keep me');
  expect(entities).toEqual([
    {
      id: 'observation',
      kind: 'observation',
      payload: {
        activeObservations: kept,
        id: 'observation',
        observationTokenCount: kept.length,
        resourceId,
        threadId: null,
      },
      threadId: null,
    },
    {
      id: resourceId,
      kind: 'resource',
      payload: { id: resourceId, items: ['b'] },
      threadId: null,
    },
  ]);
  // A request admitted after the deletion reads what it left: its retired thread cannot write.
  await expect(native(store, ['put', 'late'], deleted)).rejects.toThrow(/retired/u);
});

test('a calculator crash fails its request with a typed error; the writer serves and the next request recovers', async () => {
  const { store } = await open('calc-crash');
  await expect(native(store, ['crash'])).rejects.toBeInstanceOf(MemoryCalculatorError);
  const [row] = await store.append([{ event: { type: 'probe' }, threadId: 'thread' }]);
  expect(row?.seq).toBe(1);
  await native(store, ['put', 'after']);
  expect(await items(store)).toEqual(['after']);
});

test('the calculator module loads when the store opens, so the first request does not wait for it', async () => {
  const root = freshDir('calc-open');
  const channelName = `bst-2398-open-${root}`;
  const channel = new BroadcastChannel(channelName);
  channel.unref();
  channels.push(channel);
  const loaded = new Promise((resolve) => {
    channel.onmessage = (event) => resolve(event.data);
  });
  const module = join(root, 'announcing.mjs');
  writeFileSync(
    module,
    `new BroadcastChannel(${JSON.stringify(channelName)}).postMessage('loaded');
export const calculateMemoryMutation = (snapshot) => ({ changes: [], value: snapshot.revision });
`
  );
  const store = await StateStore.open(root, { memoryCalculatorModule: module });
  closers.push(() => store.close());
  expect(await loaded).toBe('loaded');
  expect((await native(store, ['put', 'x'])).value).toBe(0);
});

test('a calculator module that fails to load fails each request; the writer serves', async () => {
  const root = freshDir('calc-load');
  const broken = join(root, 'broken.mjs');
  writeFileSync(broken, "throw new Error('calculator module failed to load');\n");
  const store = await StateStore.open(root, { memoryCalculatorModule: broken });
  closers.push(() => store.close());
  for (const attempt of [1, 2]) {
    const failure = native(store, ['put', String(attempt)]);
    await expect(failure).rejects.toBeInstanceOf(MemoryCalculatorError);
    await expect(failure).rejects.toThrow(/failed to load/u);
  }
  expect(await store.append([{ event: { type: 'probe' }, threadId: 'thread' }])).toHaveLength(1);
  expect((await store.memory({ operation: 'read', resourceId })).entities).toEqual([]);
});

test('without the calculator capability a native request is refused', async () => {
  const root = freshDir('calc-absent');
  const store = await StateStore.open(root);
  closers.push(() => store.close());
  await expect(native(store, ['put', 'x'])).rejects.toThrow(
    'Native memory calculator capability is unavailable'
  );
});

test('close commits a memory mutation admitted before it; reset fails one in flight', async () => {
  const first = await open('calc-close');
  const admitted = native(first.store, ['hold', 'a']);
  await first.entered('a');
  const closing = first.store.close();
  first.release('a');
  await expect(admitted).resolves.toMatchObject({ revision: 1 });
  await closing;

  const second = await open('calc-reset');
  const inFlight = native(second.store, ['hold', 'b']);
  await second.entered('b');
  await second.store.reset();
  await expect(inFlight).rejects.toBeInstanceOf(MemoryCalculatorError);
});
