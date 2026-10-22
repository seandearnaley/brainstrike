// A worker read never projects past its catch-up budget: even when an append
// lands between the transport's last step and the read, the read catches up at
// most one step and refuses as behind, so the transport steps again.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, it, vi } from 'vitest';
import { IndexerError, STATE_CATCH_UP_STEP_EVENTS } from '../src/contracts.js';
import { openDesktopIndex } from '../src/desktop-index-connection.js';
import { loadStateProjection } from '../src/state-projection.js';
import { IndexWriter } from '../src/store.js';

const producer = new URL('./fixtures/state-search-schema.mjs', import.meta.url).href;
const profile = {
  dimensions: 4,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'search-vector-proof',
  provider: 'local',
} as const;
const budget = STATE_CATCH_UP_STEP_EVENTS;

const owned: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const release of owned.splice(0).reverse()) {
    await release();
  }
});

/** A state log whose threads each hold `events`, and the index options over it. */
async function seeded(threads: readonly string[], events: number) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'brainstrike-read-budget-')));
  owned.push(() => rm(root, { force: true, recursive: true }));
  const store = await StateStore.open(root);
  owned.push(() => store.close());
  for (const threadId of threads) {
    await store.append(
      Array.from({ length: events }, (_, index) => ({
        event: { runId: 'run-1', text: `garden answer ${index}`, type: 'answer', v: 1 },
        threadId,
      }))
    );
  }
  return {
    dbPath: path.join(root, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: ['canonical'],
    stateProjection: { mode: 'dev', module: producer },
    stateRoot: root,
  } as const;
}

/** The worker's own writer, in process, over a state log whose threads each hold `events`. */
async function writer(threads: readonly string[], events: number) {
  const options = await seeded(threads, events);
  const root = options.stateRoot;
  const projection = await loadStateProjection(options.stateProjection, root);
  const index = new IndexWriter(options, openDesktopIndex(options, projection), projection);
  owned.push(() => index.close());
  return index.requireState();
}

const reads = {
  coverage: (state, budget) => state.searchCoverage({ profile, threadIds: ['coverage'] }, budget),
  gc: (state, budget) => state.gcCheck({ hashes: ['a'.repeat(64)], threads: ['gc'] }, budget),
  pending: (state, budget) =>
    state.searchPending({ limit: 5, profile, threadIds: ['pending'] }, budget),
  search: (state, budget) =>
    state.search({ limit: 5, query: 'garden', threadIds: ['search'] }, budget),
  similar: (state, budget) =>
    state.searchSimilar(
      { limit: 5, profile, threadIds: ['similar'], threshold: 0.5, vector: [1, 0, 0, 0] },
      budget
    ),
} satisfies Record<string, (state: Awaited<ReturnType<typeof writer>>, budget?: number) => unknown>;

it.each(Object.entries(reads))(
  '%s catches up at most its budget, refusing as behind until its threads are current',
  async (threadId, read) => {
    const state = await writer([threadId], budget + 1);

    const behind = (() => {
      try {
        read(state, budget);
      } catch (error) {
        return error;
      }
      return;
    })();
    expect(behind).toBeInstanceOf(IndexerError);
    expect(behind).toMatchObject({ code: 'state-behind' });
    expect(state.stats(threadId).cursor).toBe(budget);

    // The rest is within one step, so this read is served.
    expect(() => read(state, budget)).not.toThrow();
    expect(state.stats(threadId).cursor).toBe(budget + 1);
  }
);

it('an in-process read with no budget catches its threads all the way up, as the web writer reads', async () => {
  const state = await writer(['search'], budget * 2 + 1);
  expect(state.search({ limit: 5, query: 'garden', threadIds: ['search'] })).toHaveLength(5);
  expect(state.stats('search').cursor).toBe(budget * 2 + 1);
});

it('the worker thread serves every read op with a one-step budget, and a refusal is no health error', async () => {
  const ops = {
    'state-gc-check': { hashes: ['a'.repeat(64)], threads: ['state-gc-check'] },
    'state-search': { limit: 5, query: 'garden', threadIds: ['state-search'] },
    'state-search-coverage': { profile, threadIds: ['state-search-coverage'] },
    'state-search-pending': { limit: 5, profile, threadIds: ['state-search-pending'] },
    'state-search-similar': {
      limit: 5,
      profile,
      threadIds: ['state-search-similar'],
      threshold: 0.5,
      vector: [1, 0, 0, 0],
    },
  };
  const options = await seeded(Object.keys(ops), budget * 2 + 1);
  const worker = new Worker(new URL('../dist/writer-worker.js', import.meta.url), {
    workerData: options,
  });
  owned.push(async () => {
    await worker.terminate();
  });
  const frames: { readonly id?: number; readonly kind: string; readonly ok?: boolean }[] = [];
  worker.on('message', (frame) => frames.push(frame));
  await vi.waitFor(() => expect(frames[0]?.kind).toBe('ready'));
  let id = 0;
  const send = async (op: string, payload: unknown) => {
    const request = ++id;
    worker.postMessage({ id: request, op, payload });
    await vi.waitFor(() => expect(frames.some((frame) => frame.id === request)).toBe(true));
    return frames.find((frame) => frame.id === request);
  };

  for (const [op, payload] of Object.entries(ops)) {
    // Sent raw, past the transport's steps: each read projects one step and refuses.
    await expect(send(op, payload)).resolves.toMatchObject({
      error: { code: 'state-behind' },
      ok: false,
    });
    await expect(send(op, payload)).resolves.toMatchObject({ ok: false });
    await expect(send(op, payload)).resolves.toMatchObject({ ok: true });
  }
  await expect(send('state-health', null)).resolves.toMatchObject({
    ok: true,
    value: { indexerErrors: [] },
  });
});
