/**
 * The thread list answers while Core folds a long history: a window lists every thread at once, and once the fold
 * is done Core's own list answers, with the same facts.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const platform: HostPlatform = {
  close: async () => undefined,
  maxSteps: 1,
  readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
  resolveModel: async () => {
    throw new Error('No model');
  },
  tools: {},
};

/** The store, with its full hydration read held until `release`. */
function holdingFullRead(store: StateStore) {
  const held = Promise.withResolvers<void>();
  const gated = new Proxy(store, {
    get(target, key) {
      if (key === 'readHydration') {
        return async (types?: readonly string[]) => {
          if (!types) {
            await held.promise;
          }
          return target.readHydration(types);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { release: held.resolve, store: gated };
}

test('the thread list answers before Core has read every thread, then from Core with the same facts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bs-thread-listing-'));
  const store = await StateStore.open(dir);
  cleanup.push(async () => {
    await store.close();
    await rm(dir, { force: true, recursive: true });
  });
  const first = await HostCore.open(store, platform, () => () => undefined);
  const { threadId: titled } = await first.startThread({ commandId: randomUUID() });
  await first.updateThread({ commandId: randomUUID(), threadId: titled, title: 'Plan the launch' });
  const { threadId: untitled } = await first.startThread({ commandId: randomUUID() });
  await first.close();

  const { release, store: held } = holdingFullRead(store);
  const core = HostCore.start(held, platform, () => () => undefined);
  cleanup.push(async () => {
    release();
    await core.close();
  });
  let folded = false;
  void core.hydrated.then(() => {
    folded = true;
  });
  const list = () => core.listing.read(() => core.listThreads());

  const early = await list();
  expect(folded).toBe(false);
  expect(early.map(({ threadId, title }) => ({ threadId, title })).sort(byThread)).toEqual(
    [
      { threadId: titled, title: 'Plan the launch' },
      { threadId: untitled, title: undefined },
    ].sort(byThread)
  );

  release();
  await core.hydrated;
  expect(await list()).toEqual(early);
});

const byThread = (a: { threadId: string }, b: { threadId: string }): number =>
  a.threadId.localeCompare(b.threadId);
