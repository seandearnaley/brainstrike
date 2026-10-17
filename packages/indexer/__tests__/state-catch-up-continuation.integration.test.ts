// Bounded catch-up steps over many threads resume where the last step stopped
// (BST-2042): a late thread's backlog costs one thread visit per step, not a
// fresh pass over every thread already current before it.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, it, vi } from 'vitest';
import { openDesktopIndex } from '../src/desktop-index-connection.js';
import { loadStateProjection } from '../src/state-projection.js';
import { IndexWriter } from '../src/store.js';

const producer = new URL('./fixtures/state-search-schema.mjs', import.meta.url).href;

const owned: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const release of owned.splice(0).reverse()) {
    await release();
  }
});

/** The worker's own writer, in process, over a state log seeded with `events` per thread. */
async function writer(events: Readonly<Record<string, number>>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'brainstrike-continuation-')));
  owned.push(() => rm(root, { force: true, recursive: true }));
  const log = await StateStore.open(root);
  owned.push(() => log.close());
  for (const [threadId, count] of Object.entries(events)) {
    await log.append(
      Array.from({ length: count }, (_, index) => ({
        event: { runId: 'run-1', text: `answer ${index}`, type: 'answer', v: 1 },
        threadId,
      }))
    );
  }
  const options = {
    dbPath: path.join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: ['canonical'],
    stateProjection: { mode: 'dev', module: producer },
    stateRoot: root,
  } as const;
  const projection = await loadStateProjection(options.stateProjection, root);
  const index = new IndexWriter(options, openDesktopIndex(options, projection), projection);
  owned.push(() => index.close());
  return { log, state: index.requireState() };
}

/** Counts the store's authoritative watermark reads, one per thread visit. */
function countVisits(state: object): { readonly visits: () => number } {
  const truth = (state as { readonly truth: { watermark(threadId: string): number } }).truth;
  const watermark = vi.spyOn(truth, 'watermark');
  return { visits: () => watermark.mock.calls.length };
}

const current = Array.from({ length: 19 }, (_, index) => `current-${index}`);

it('a late thread behind many current ones costs O(threads + steps) visits, not their product', async () => {
  const late = 12;
  const { state } = await writer({
    ...Object.fromEntries(current.map((threadId) => [threadId, 1])),
    late,
  });
  const threads = [...current, 'late'];
  // One step projects every current thread's one event and stops at the late thread.
  expect(state.catchUpStep({ maxEvents: current.length, threads })).toBe(false);
  expect(state.stats('late').cursor).toBe(0);

  const { visits } = countVisits(state);
  let steps = 0;
  let caughtUp = false;
  while (!caughtUp) {
    caughtUp = state.catchUpStep({ maxEvents: 2, threads });
    steps += 1;
  }
  // Each step resumes at the late thread; the last also checks every thread once.
  expect(visits()).toBeLessThanOrEqual(steps + threads.length);
  expect(state.stats('late').cursor).toBe(late);
  for (const threadId of current) {
    expect(state.stats(threadId).cursor).toBe(1);
  }
});

it('reports current only after every thread is checked, including one behind the resume point', async () => {
  const { log, state } = await writer({ first: 1, second: 4 });
  const threads = ['first', 'second'];
  expect(state.catchUpStep({ maxEvents: 3, threads })).toBe(false);
  expect(state.stats('second').cursor).toBe(2);

  // The next step resumes at `second`, but `first` gained an event meanwhile.
  await log.append([
    { event: { runId: 'run-2', text: 'late answer', type: 'answer', v: 1 }, threadId: 'first' },
  ]);
  expect(state.catchUpStep({ maxEvents: 3, threads })).toBe(true);
  expect(state.stats('first').cursor).toBe(2);
  expect(state.stats('second').cursor).toBe(4);
});

it('a step over a different thread list starts from its first thread', async () => {
  const { state } = await writer({ alpha: 3, beta: 3 });
  expect(state.catchUpStep({ maxEvents: 4, threads: ['alpha', 'beta'] })).toBe(false);
  expect(state.stats('beta').cursor).toBe(1);

  expect(state.catchUpStep({ maxEvents: 1, threads: ['beta'] })).toBe(false);
  expect(state.stats('beta').cursor).toBe(2);
  expect(state.catchUpStep({ maxEvents: 10, threads: ['alpha', 'beta'] })).toBe(true);
  expect(state.stats('beta').cursor).toBe(3);
});
