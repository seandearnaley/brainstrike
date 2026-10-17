/**
 * The browser host client's ordering, over a writer whose announcements the
 * test delivers by hand (BST-1940), so a race between a replay, an
 * announcement and this tab's own commit is played exactly.
 */
import { storedHostEvent } from '@brainstrike/agent-host/host-event-encoding';
import type { HostEvent } from '@brainstrike/agent-host/protocol';
import { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import plan from '@brainstrike/test-utils/fixtures/committed-host-plan.json' with { type: 'json' };
import type {
  WebStateLogAppend,
  WebStateStore,
  WebStateStoredRow,
} from '@brainstrike/web-state-store';
import { describe, expect, it } from 'vitest';
import { WebHostClient } from '../web-host-client';

const THREAD = 'thread';

function scriptedStore() {
  const rows: WebStateStoredRow[] = [];
  const blobs = new Map<string, string>();
  const listeners = new Set<(append: WebStateLogAppend) => void>();
  let damage: string | null = null;
  let hydration: Promise<void> = Promise.resolve();
  const stored = (body: object): number => {
    const seq = rows.length + 1;
    rows.push({ crc: 0, payload: JSON.stringify({ seq, ...body }), rawCount: null, seq, ts: seq });
    return seq;
  };
  const store = {
    // This tab's appends commit at once and are announced when the test says.
    append: async (appended: readonly (readonly [string, string, unknown, string])[]) => ({
      seqs: appended.map(([, , , payload]) => stored(JSON.parse(payload) as object)),
      ts: rows.length,
    }),
    read: async (_threadId: string, fromSeq: number, limit: number) =>
      damage
        ? { damage: { atSeq: fromSeq, error: damage }, rows: [] }
        : { damage: null, rows: rows.filter((row) => row.seq >= fromSeq).slice(0, limit) },
    readBlob: async (hash: string) => ({ content: blobs.get(hash) ?? null }),
    readHydration: async () => {
      const read = [...rows];
      await hydration;
      return {
        threads:
          read.length === 0
            ? []
            : [
                {
                  createdAt: 1,
                  damage: null,
                  rows: read,
                  threadId: THREAD,
                  updatedAt: read.length,
                },
              ],
      };
    },
    subscribeLog: (listener: (append: WebStateLogAppend) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    threads: async () => ({ threads: rows.length > 0 ? [THREAD] : [] }),
  } as unknown as WebStateStore;
  return {
    announce: (...seqs: number[]): void => {
      for (const listener of listeners) {
        listener({ seqs, threadId: THREAD });
      }
    },
    /** Another tab's commit, not yet announced. */
    commit: (event: HostEvent): number => {
      const item = storedHostEvent(THREAD, event);
      for (const blob of item.blobs ?? []) {
        blobs.set(blob.hash, blob.content);
      }
      return stored(item.event);
    },
    damageReads: (error: string): void => {
      damage = error;
    },
    /** Holds the next hydration read, as one still reading when a commit is announced. */
    holdHydration: (): (() => void) => {
      let release = () => {};
      hydration = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    store,
  };
}

describe("the browser host client's ordering", () => {
  it('gives no subscriber a row its replay already read, when the announcement comes after', async () => {
    const { announce, commit, store } = scriptedStore();
    const host = await WebHostClient.open(store);
    const seen: number[] = [];
    host.onEvent((row) => seen.push(row.seq));

    announce(commit({ commandId: 'start', type: 'thread.started' }));
    await expect.poll(async () => (await host.request('thread/list', {})).threads.length).toBe(1);
    // Another tab commits a row; this tab's replay reads it before its announcement is handled.
    const raced = commit({ title: 'Raced', type: 'thread.updated' });
    const { rows } = await host.request('log/subscribe', { fromSeq: 0, threadId: THREAD });
    expect(rows.map((row) => row.seq)).toEqual([1, raced]);
    announce(raced);

    const live = commit({ title: 'Live', type: 'thread.updated' });
    announce(live);
    await expect.poll(() => seen).toEqual([live]);
    await host.close();
  });

  it("gives a thread's first subscriber the rows a second subscriber's replay read first", async () => {
    const { announce, commit, store } = scriptedStore();
    const host = await WebHostClient.open(store);
    announce(commit({ commandId: 'start', type: 'thread.started' }));
    await expect.poll(async () => (await host.request('thread/list', {})).threads.length).toBe(1);
    const first = new CommittedThreadSession(host, THREAD);
    const disconnect = first.connect();
    await expect.poll(() => first.getSnapshot().isLoading).toBe(false);
    const seqs = () => first.getSnapshot().rows.map((row) => row.seq);
    expect(seqs()).toEqual([1]);

    // Another tab renames; a second view in this tab subscribes before the announcement is handled.
    const raced = commit({ title: 'Raced', type: 'thread.updated' });
    const second = await host.request('log/subscribe', { fromSeq: 0, threadId: THREAD });
    expect(second.rows.map((row) => row.seq)).toEqual([1, raced]);
    await expect.poll(seqs).toEqual([1, raced]);
    announce(raced);

    const live = commit({ title: 'Live', type: 'thread.updated' });
    announce(live);
    await expect.poll(seqs).toEqual([1, raced, live]);
    await disconnect();
    await host.close();
  });

  it("folds another tab's row before this tab's own commit that overtook its announcement", async () => {
    const { announce, commit, store } = scriptedStore();
    const host = await WebHostClient.open(store);
    announce(commit({ commandId: 'start', type: 'thread.started' }));
    await expect.poll(async () => (await host.request('thread/list', {})).threads.length).toBe(1);

    // Another tab sets the icon; this tab renames before hearing of it.
    const icon = commit({ icon: 'kestrel', type: 'thread.updated' });
    await host.request('thread/update', { commandId: 'rename', threadId: THREAD, title: 'Mine' });
    announce(icon);
    announce(icon + 1, icon + 2);

    const { threads } = await host.request('thread/list', {});
    expect(threads).toEqual([expect.objectContaining({ icon: 'kestrel', title: 'Mine' })]);
    await host.close();
  });

  it('folds a row committed after its hydration read once, after the hydration folds', async () => {
    const { announce, commit, holdHydration, store } = scriptedStore();
    const events = (plan as readonly { readonly event: HostEvent }[]).map(({ event }) => event);
    for (const event of events.slice(0, -1)) {
      commit(event);
    }
    const release = holdHydration();
    const opening = WebHostClient.open(store);
    // The run's finish commits after the hydration read, and is announced before that read returns.
    announce(commit(events.at(-1) as HostEvent));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const raced = await opening;
    const calm = await WebHostClient.open(store);

    expect(await raced.request('ledger/read', {})).toEqual(await calm.request('ledger/read', {}));
    expect((await raced.request('thread/list', {})).threads).toEqual(
      (await calm.request('thread/list', {})).threads
    );
    await raced.close();
    await calm.close();
  });

  it('refuses to open over a delegated child thread, which a web turn never commits', async () => {
    const { commit, store } = scriptedStore();
    commit({
      origin: {
        background: false,
        depth: 1,
        parentRunId: 'parent-run',
        parentThreadId: 'parent',
        persona: 'worker',
        toolCallId: 'call-1',
        turnId: 'parent-run',
      },
      type: 'thread.started',
    });
    await expect(WebHostClient.open(store)).rejects.toThrow(
      'Thread thread is a delegated child thread, which the browser host does not serve'
    );
  });

  it('closes with the reason when it cannot read a row it was told of, and serves nothing after', async () => {
    const { announce, commit, damageReads, store } = scriptedStore();
    const host = await WebHostClient.open(store);
    damageReads('Row 1 failed its crc');
    announce(commit({ commandId: 'start', type: 'thread.started' }));

    await expect(host.closed).rejects.toThrow('Row 1 failed its crc');
    await expect(host.request('thread/list', {})).rejects.toThrow('Row 1 failed its crc');
  });
});
