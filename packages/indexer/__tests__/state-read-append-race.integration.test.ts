// An append that commits between the transport's last catch-up step and the
// read is never projected inside the read: the worker refuses the read as
// behind, and the transport steps again and reads once more. Real process,
// real transport, real append, injected exactly between the two requests.
import { fork } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { STATE_CATCH_UP_STEP_EVENTS } from '@brainstrike/indexer';
import { StateStore } from '@brainstrike/state-store';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createIndexerConnection } from '../src/transport.js';

const producer = new URL('./fixtures/state-search-schema.mjs', import.meta.url).href;
const profile = {
  dimensions: 4,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'search-vector-proof',
  provider: 'local',
} as const;
const step = STATE_CATCH_UP_STEP_EVENTS;
type Port = Awaited<ReturnType<typeof createIndexerConnection>['ready']>;

const reads: Readonly<Record<string, (port: Port) => Promise<unknown>>> = {
  'state-gc-check': (port) => port.stateBlobCounts(['state-gc-check'], ['a'.repeat(64)]),
  'state-search': (port) =>
    port.searchState({ limit: 5, query: 'garden', threadIds: ['state-search'] }),
  'state-search-coverage': (port) =>
    port.searchStateCoverage({ profile, threadIds: ['state-search-coverage'] }),
  'state-search-pending': (port) =>
    port.searchStatePending({ limit: 5, profile, threadIds: ['state-search-pending'] }),
  'state-search-similar': (port) =>
    port.searchStateSimilar({
      limit: 5,
      profile,
      threadIds: ['state-search-similar'],
      threshold: 0.5,
      vector: [1, 0, 0, 0],
    }),
};

const sent: string[] = [];
const raced = new Set<string>();
let store: StateStore;
let port: Port;
let release: () => Promise<void>;

const append = (threadId: string, count: number): Promise<unknown> =>
  store.append(
    Array.from({ length: count }, (_, index) => ({
      event: { runId: 'run-1', text: `garden answer ${index}`, type: 'answer', v: 1 },
      threadId,
    }))
  );

beforeAll(async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'brainstrike-read-race-')));
  store = await StateStore.open(root);
  for (const threadId of Object.keys(reads)) {
    await append(threadId, step + 1);
  }
  const child = fork(new URL('../dist/process-entry.js', import.meta.url), [], {
    execArgv: [],
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const connection = createIndexerConnection(
    {
      dbPath: path.join(root, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      rootIds: ['canonical'],
      stateProjection: { mode: 'dev', module: producer },
      stateRoot: root,
    },
    { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 },
    {
      kill: () => child.kill(),
      onError: (listener) => {
        child.on('error', listener);
        return () => {
          child.off('error', listener);
        };
      },
      onExit: (listener) => {
        child.on('exit', listener);
        return () => {
          child.off('exit', listener);
        };
      },
      onMessage: (listener) => {
        child.on('message', listener);
        return () => {
          child.off('message', listener);
        };
      },
      send: (message) => {
        const op = (message as { readonly op?: string }).op;
        if (op === undefined || !(op in reads) || raced.has(op)) {
          if (op !== undefined) {
            sent.push(op);
          }
          child.send(message);
          return;
        }
        // The first read of this op: two steps' worth of events commit before it is sent.
        raced.add(op);
        sent.push(op);
        void append(op, step * 2).then(() => child.send(message));
      },
    }
  );
  port = await connection.ready;
  release = async () => {
    await connection.close();
    await store.close();
    await rm(root, { force: true, recursive: true });
  };
}, 60_000);

afterAll(() => release());

it.each(Object.keys(reads))(
  '%s: an append racing the last step is refused inside the read, stepped, then read again',
  async (op) => {
    const from = sent.length;
    await reads[op]?.(port);
    const ops = sent.slice(from);
    const first = ops.indexOf(op);
    // Steps, the raced read (it projects one step, then refuses as behind), the
    // steps for the rest of the append, then the read that is served.
    expect(ops.slice(0, first).every((name) => name === 'state-catch-up-step')).toBe(true);
    expect(ops.slice(first + 1, -1).length).toBeGreaterThanOrEqual(1);
    expect(ops.slice(first + 1, -1).every((name) => name === 'state-catch-up-step')).toBe(true);
    expect(ops.at(-1)).toBe(op);
    expect((await port.stateStats(op)).cursor).toBe(step * 3 + 1);
    await expect(port.stateHealth()).resolves.toEqual({ indexerErrors: [] });
  }
);
