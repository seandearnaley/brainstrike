// Every entry point that catches the state index up, over a cold backlog far
// past one catch-up step and behind a request deadline far shorter than that
// backlog's projection in one request: each is served, and the worker lives.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createStateStoreIndexer,
  openIndexer,
  STATE_CATCH_UP_STEP_EVENTS,
} from '@brainstrike/indexer';
import { StateStore } from '@brainstrike/state-store';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * 60 steps. Projecting all of it in one request overruns this deadline about
 * twice over, while one step, even one overwriting rows, stays well inside it.
 */
const BACKLOG = STATE_CATCH_UP_STEP_EVENTS * 60;
const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 1000, startupMs: 5000 };
const producer = new URL('./fixtures/state-search-schema.mjs', import.meta.url).href;
const profile = {
  dimensions: 4,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'search-vector-proof',
  provider: 'local',
} as const;

let port: Awaited<ReturnType<typeof openIndexer>>;
let release: () => Promise<void>;

beforeAll(async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'brainstrike-state-backlog-')));
  port = await openIndexer(
    {
      dbPath: path.join(root, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      rootIds: ['canonical'],
      stateProjection: { mode: 'dev', module: producer },
      stateRoot: root,
    },
    deadlines
  );
  const store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
  // One cold thread per entry point, so each meets the whole backlog itself.
  for (const threadId of ['search', 'pending', 'coverage', 'similar', 'rebuild', 'gc']) {
    await store.append(
      Array.from({ length: BACKLOG }, (_, index) => ({
        event: { runId: 'run-1', text: `garden answer ${index}`, type: 'answer', v: 1 },
        threadId,
      }))
    );
  }
  release = async () => {
    await store.close();
    await port.close();
    await rm(root, { force: true, recursive: true });
  };
}, 120_000);

afterAll(() => release());

const entryPoints: readonly [string, () => Promise<unknown>, (served: unknown) => void][] = [
  [
    'search',
    () => port.searchState({ limit: 5, query: 'garden', threadIds: ['search'] }),
    (hits) => expect(hits).toHaveLength(5),
  ],
  [
    'pending',
    () => port.searchStatePending({ limit: 10, profile, threadIds: ['pending'] }),
    (rows) => expect(rows).toHaveLength(10),
  ],
  [
    'coverage',
    () => port.searchStateCoverage({ profile, threadIds: ['coverage'] }),
    (coverage) => expect(coverage).toEqual({ embedded: 0, errored: 0, rows: BACKLOG }),
  ],
  [
    'similar',
    () =>
      port.searchStateSimilar({
        limit: 5,
        profile,
        threadIds: ['similar'],
        threshold: 0.5,
        vector: [1, 0, 0, 0],
      }),
    (hits) => expect(hits).toEqual([]),
  ],
  [
    'rebuild',
    async () => {
      await port.catchUpState(['rebuild']);
      await port.rebuildState('rebuild');
      return port.stateStats('rebuild');
    },
    (stats) => expect(stats).toMatchObject({ cursor: BACKLOG, docs: BACKLOG }),
  ],
  [
    'gc',
    () => port.stateBlobCounts(['gc'], ['a'.repeat(64)]),
    (counts) => expect(counts).toEqual({ ['a'.repeat(64)]: 0 }),
  ],
];

it.each(entryPoints)(
  '%s over a cold backlog is served, every request inside the deadline',
  async (threadId, serve, check) => {
    check(await serve());
    expect((await port.stateStats(threadId)).cursor).toBe(BACKLOG);
    // Retirement would have failed the connection: the same worker still answers.
    await expect(port.stateHealth()).resolves.toEqual({ indexerErrors: [] });
  },
  60_000
);
