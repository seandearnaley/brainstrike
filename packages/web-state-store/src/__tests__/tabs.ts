import { expect } from 'vitest';
import {
  type WebStateAppendRow,
  type WebStateStoreConfig,
  type WebStateTestHooks,
  webStateNames,
} from '../protocol';
import { type WebStateLeaseView, WebStateStore, WebStateStoreError } from '../web-state-client';

const opened: WebStateStore[] = [];
const pools: string[] = [];

/** A store of its own: its own lock, channel and OPFS pool. */
export function storeConfig(testHooks?: WebStateTestHooks): WebStateStoreConfig {
  const name = `test-${crypto.randomUUID()}`;
  pools.push(webStateNames(name).pool);
  return { name, testHooks };
}

/** One tab's handle: its own worker on the shared store. */
export async function openTab(config: WebStateStoreConfig): Promise<WebStateStore> {
  const worker = new Worker(new URL('../web-state-worker.ts', import.meta.url), { type: 'module' });
  const store = await WebStateStore.open(worker, config);
  opened.push(store);
  return store;
}

export function nextLease(store: WebStateStore): Promise<WebStateLeaseView> {
  return new Promise((resolve) => {
    const unsubscribe = store.subscribeLease((view) => {
      unsubscribe();
      resolve(view);
    });
  });
}

export function event(threadId: string, n: number): WebStateAppendRow {
  return [
    threadId,
    'text.delta',
    'run-1',
    JSON.stringify({ n, text: `delta ${n} ✓`, type: 'text.delta' }),
    null,
    1,
  ];
}

export async function removePool(name: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(webStateNames(name).pool, { recursive: true });
}

export async function rejection(promise: Promise<unknown>): Promise<WebStateStoreError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WebStateStoreError);
    return error as WebStateStoreError;
  }
  throw new Error('expected the request to fail');
}

/** Closes every tab a test opened and removes its pools; register with `afterEach`. */
export async function closeTabs(): Promise<void> {
  for (const store of opened.splice(0)) {
    store.close();
  }
  const root = await navigator.storage.getDirectory();
  for (const pool of pools.splice(0)) {
    // A terminated worker releases its access handles shortly after; retry until it has.
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await root.removeEntry(pool, { recursive: true });
        break;
      } catch (error) {
        if ((error as DOMException).name === 'NotFoundError') {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }
}
