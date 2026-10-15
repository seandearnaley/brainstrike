import { verified } from '@brainstrike/state-store/run-log-format';
import { SCHEMA_VERSION } from '@brainstrike/state-store/schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WEB_STATE_PROTOCOL,
  type WebStateAppendRow,
  type WebStateStoreConfig,
  type WebStateTestHooks,
  webStateNames,
} from '../protocol';
import { type WebStateLeaseView, WebStateStore, WebStateStoreError } from '../web-state-client';

const opened: WebStateStore[] = [];
const pools: string[] = [];

/** A store of its own: its own lock, channel and OPFS pool. */
function storeConfig(testHooks?: WebStateTestHooks): WebStateStoreConfig {
  const name = `test-${crypto.randomUUID()}`;
  pools.push(webStateNames(name).pool);
  return { name, testHooks };
}

/** One tab's handle: its own worker on the shared store. */
async function openTab(config: WebStateStoreConfig): Promise<WebStateStore> {
  const worker = new Worker(new URL('../web-state-worker.ts', import.meta.url), { type: 'module' });
  const store = await WebStateStore.open(worker, config);
  opened.push(store);
  return store;
}

function nextLease(store: WebStateStore): Promise<WebStateLeaseView> {
  return new Promise((resolve) => {
    const unsubscribe = store.subscribeLease((view) => {
      unsubscribe();
      resolve(view);
    });
  });
}

function event(threadId: string, n: number): WebStateAppendRow {
  return [
    threadId,
    'text.delta',
    'run-1',
    JSON.stringify({ n, text: `delta ${n} ✓`, type: 'text.delta' }),
    null,
    1,
  ];
}

async function removePool(name: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(webStateNames(name).pool, { recursive: true });
}

async function rejection(promise: Promise<unknown>): Promise<WebStateStoreError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WebStateStoreError);
    return error as WebStateStoreError;
  }
  throw new Error('expected the request to fail');
}

afterEach(async () => {
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
});

describe('the browser state writer', () => {
  it('opens the shared state schema with the web PRAGMAs, as the first writer', async () => {
    const tab = await openTab(storeConfig());
    expect(tab.lease.leader).toBe(true);
    expect(tab.lease.lease.epoch).toBe(1);
    expect(await tab.settings()).toMatchObject({
      foreignKeys: 1,
      journalMode: 'wal',
      lockingMode: 'exclusive',
      secureDelete: 1,
      synchronous: 1,
      userVersion: SCHEMA_VERSION,
      walAutocheckpoint: 0,
    });
    expect(await tab.threads()).toEqual({ threads: [] });
  });

  it('keeps committed events across a reload', async () => {
    const config = storeConfig();
    const first = await openTab(config);
    const appended = await first.append([event('thread-a', 1), event('thread-a', 2)], {
      boundary: true,
    });
    expect(appended.seqs).toEqual([1, 2]);
    first.close();

    const reloaded = await openTab(config);
    expect(reloaded.lease).toMatchObject({ leader: true, lease: { epoch: 2 } });
    const read = await reloaded.read('thread-a', 1, 10);
    expect(read.damage).toBeNull();
    expect(read.rows.map((row) => JSON.parse(row.payload))).toEqual([
      { n: 1, seq: 1, text: 'delta 1 ✓', type: 'text.delta' },
      { n: 2, seq: 2, text: 'delta 2 ✓', type: 'text.delta' },
    ]);
    expect(read.rows.every((row) => verified(row))).toBe(true);
    expect(await reloaded.check()).toEqual({ gaps: 0, integrity: 'ok' });
  });

  it('gives two tabs one writer, and both write through it', async () => {
    const config = storeConfig();
    const writerTab = await openTab(config);
    const otherTab = await openTab(config);
    expect(writerTab.lease.leader).toBe(true);
    expect(otherTab.lease.leader).toBe(false);
    expect(otherTab.lease.lease).toEqual(writerTab.lease.lease);

    const fromOther = await otherTab.append([event('shared', 1)]);
    const fromWriter = await writerTab.append([event('shared', 2)]);
    const again = await otherTab.append([event('shared', 3)]);
    expect([...fromOther.seqs, ...fromWriter.seqs, ...again.seqs]).toEqual([1, 2, 3]);

    const seenByOther = await otherTab.read('shared', 1, 10);
    const seenByWriter = await writerTab.read('shared', 1, 10);
    expect(seenByOther).toEqual(seenByWriter);
    expect(seenByOther.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it('passes the writing to a waiting tab when the writer tab closes, under the next epoch', async () => {
    const config = storeConfig();
    const writerTab = await openTab(config);
    const otherTab = await openTab(config);
    await writerTab.append([event('kept', 1)], { boundary: true });

    const takeover = nextLease(otherTab);
    writerTab.close();
    expect(await takeover).toMatchObject({ leader: true, lease: { epoch: 2 } });
    expect((await otherTab.read('kept', 1, 10)).rows).toHaveLength(1);
    expect((await otherTab.append([event('kept', 2)])).seqs).toEqual([2]);

    const lateTab = await openTab(config);
    expect(lateTab.lease).toEqual({ leader: false, lease: otherTab.lease.lease });
    expect((await lateTab.read('kept', 1, 10)).rows.map((row) => row.seq)).toEqual([1, 2]);
  });

  it('fails a request the old writer never answered as leader-lost, and does not send it again', async () => {
    const config = storeConfig({ allowStall: true });
    const writerTab = await openTab(config);
    const otherTab = await openTab(config);

    const stalled = otherTab.request('stall', {});
    // Let the request reach the writer before its tab goes.
    await otherTab.threads();
    const takeover = nextLease(otherTab);
    writerTab.close();
    expect((await rejection(stalled)).kind).toBe('leader-lost');
    expect((await takeover).leader).toBe(true);
    expect(await otherTab.threads()).toEqual({ threads: [] });
  });

  it('never applies an append twice when the writer tab closes as it arrives', async () => {
    for (let round = 0; round < 5; round++) {
      const config = storeConfig();
      const writerTab = await openTab(config);
      const otherTab = await openTab(config);
      const takeover = nextLease(otherTab);
      const append = otherTab.append([event('race', round)]);
      writerTab.close();
      const outcome = await append.then(
        () => 'applied' as const,
        (error: unknown) => (error as WebStateStoreError).kind
      );
      await takeover;
      const rows = (await otherTab.read('race', 1, 10)).rows;
      // Applied: exactly once. Leader-lost: the old writer may or may not have committed it, but never twice.
      if (outcome === 'applied') {
        expect(rows).toHaveLength(1);
      } else {
        expect(outcome).toBe('leader-lost');
        expect(rows.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('records a higher epoch for every writer', async () => {
    const config = storeConfig();
    const epochs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const tab = await openTab(config);
      epochs.push(tab.lease.lease.epoch);
      tab.close();
    }
    expect(epochs).toEqual([1, 2, 3]);
  });

  it('fails the requests of a closed tab as closed', async () => {
    const tab = await openTab(storeConfig());
    tab.close();
    expect((await rejection(tab.threads())).kind).toBe('closed');
  });

  it('refuses an event that references a blob, since the browser store keeps none', async () => {
    const tab = await openTab(storeConfig());
    const blob = 'a'.repeat(64);
    const error = await rejection(
      tab.append([
        ['thread', 'tool.output', 'run-1', JSON.stringify({ blob, type: 'tool.output' }), null, 1],
      ])
    );
    expect(error.kind).toBe('failed');
    expect(error.message).toContain('no blob storage');
    expect(await tab.threads()).toEqual({ threads: [] });
  });

  it('retires for factory reset: the pool can be deleted, no tab reopens it, and the next open is fresh', async () => {
    const config = storeConfig();
    const writerTab = await openTab(config);
    const otherTab = await openTab(config);
    await writerTab.append([event('before-reset', 1)], { boundary: true });

    // Any tab may start the reset; this one forwards it to the writer.
    expect(await otherTab.retire()).toEqual({});
    // Every OPFS handle is released, so the reset can delete the pool now.
    await removePool(config.name);
    expect((await rejection(writerTab.threads())).kind).toBe('unavailable');
    expect((await rejection(otherTab.threads())).kind).toBe('unavailable');
    // A tab opened mid-reset hears that the store is retired instead of reopening it.
    expect((await rejection(openTab(config).then(() => undefined))).kind).toBe('unavailable');

    // The reset reloads every tab; the next writer opens an empty store at the first epoch.
    writerTab.close();
    otherTab.close();
    const afterReset = await openTab(config);
    expect(afterReset.lease).toMatchObject({ leader: true, lease: { epoch: 1 } });
    expect(await afterReset.threads()).toEqual({ threads: [] });
  });

  it("refuses a writer that speaks another version's protocol, instead of forwarding to it", async () => {
    const config = storeConfig();
    const names = webStateNames(config.name);
    // This page plays a writer from another build: it holds the lock and answers `who`.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      void navigator.locks.request(names.lock, () => {
        resolve();
        return new Promise<void>((done) => {
          release = done;
        });
      });
    });
    await held;
    const otherBuild = new BroadcastChannel(names.channel);
    otherBuild.onmessage = (message: MessageEvent<{ kind: string }>) => {
      if (message.data.kind === 'who') {
        otherBuild.postMessage({
          kind: 'leader',
          lease: { epoch: 7, instanceId: 'other-build' },
          protocol: WEB_STATE_PROTOCOL + 1,
        });
      }
    };
    try {
      const refused = await rejection(openTab(config).then(() => undefined));
      expect(refused.kind).toBe('unavailable');
      expect(refused.message).toContain(`protocol ${WEB_STATE_PROTOCOL + 1}`);
    } finally {
      otherBuild.close();
      release();
    }
  });

  // The ship gate (BST-1940, owner decision 15 Oct): through 3.53.x a failed
  // `opfs-sahpool` init calls removeVfs(), deleting every database in the pool.
  // Upstream check-in ad1bbfc2bd (3.54) adds preserveOnInitFailure. This
  // reports the destruction until the pinned build keeps the pool; then it
  // passes, `it.fails` turns it red, and the web app may run on this store.
  it.fails('keeps the stored state when the pool fails to initialize', async () => {
    const config = storeConfig();
    const first = await openTab(config);
    await first.append([event('survivor', 1)], { boundary: true });
    first.close();

    const failing = await rejection(
      openTab({ ...config, testHooks: { failPoolInitOnce: true } }).then(() => undefined)
    );
    expect(failing.kind).toBe('unavailable');

    const recovered = await openTab(config);
    expect((await recovered.read('survivor', 1, 10)).rows).toHaveLength(1);
  });
});
