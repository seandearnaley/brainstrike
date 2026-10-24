import { pathToFileURL } from 'node:url';
// Every entry point that catches the state index up, over a cold backlog far
// past one catch-up step: each is served, the worker lives, and no request it
// sends takes half as long as that backlog's projection in one request.
import { fork } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createStateStoreIndexer,
  openIndexer,
  STATE_CATCH_UP_STEP_EVENTS,
} from '@brainstrike/indexer';
import { StateStore } from '@brainstrike/state-store';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createIndexerConnection } from '@brainstrike/indexer/transport';
import { nodeRuntimeBundleFile } from '@brainstrike/test-utils/node-runtime-bundle';


type Port = Awaited<ReturnType<typeof openIndexer>>;

/** 60 steps. */
const BACKLOG = STATE_CATCH_UP_STEP_EVENTS * 60;
/**
 * 20 steps, not 60: overwrite steps grow with rebuild progress (BST-2153); this
 * case proves stepping and the budget, not that growth.
 */
const REBUILD_BACKLOG = STATE_CATCH_UP_STEP_EVENTS * 20;
const backlogs: Readonly<Record<string, number>> = {
  coverage: BACKLOG,
  gc: BACKLOG,
  pending: BACKLOG,
  rebuild: REBUILD_BACKLOG,
  search: BACKLOG,
  similar: BACKLOG,
};
/**
 * Each case proves its backlog is served in bounded steps (BST-2214) by what
 * the requests carry, not by wall-clock time: no catch-up step asks for more
 * than STATE_CATCH_UP_STEP_EVENTS, and the backlog takes at least
 * backlog / STATE_CATCH_UP_STEP_EVENTS steps. A clock budget measured against an
 * earlier calibration failed whenever parallel lanes loaded the machine.
 */
const deadlines = { closeMs: 5000, exitMs: 5000 };
const producer = new URL('./fixtures/state-search-schema.mjs', import.meta.url).href;
const profile = {
  dimensions: 4,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'search-vector-proof',
  provider: 'local',
} as const;

let root: string;
/** The index the calibration and every case open. */
let options: unknown;
let entry: string;

/** One request to a measured indexer: its order, op, step size and timings. */
interface TimedRequest {
  readonly index: number;
  indexerMs?: number;
  /** The events a `state-catch-up-step` request asked for. */
  readonly maxEvents?: number;
  readonly op: string;
  roundTripMs?: number;
  readonly sent: number;
}

/** The indexer process entry, also reporting how long each request spent inside it. */
const timedEntry = `const received = new Map();
process.on('message', (message) => {
  if (typeof message?.id === 'number' && typeof message.op === 'string') {
    received.set(message.id, performance.now());
  }
});
const send = process.send.bind(process);
process.send = (message, ...rest) => {
  const at = received.get(message?.id);
  if (at !== undefined) {
    received.delete(message.id);
    process.stderr.write(\`[indexer-reply] \${message.id} \${Math.round(performance.now() - at)}\\n\`);
  }
  return send(message, ...rest);
};
await import(${JSON.stringify(pathToFileURL(nodeRuntimeBundleFile('process-entry.js')).href)});
`;

/**
 * openIndexer's own fork and connection, with the slowest requests it sent, so
 * a request over its budget is named.
 */
async function openTimedIndexer() {
  const requests = new Map<number, TimedRequest>();
  const child = fork(entry, [], {
    execArgv: [],
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
  });
  let partial = '';
  child.stderr?.on('data', (bytes: Buffer) => {
    const lines = `${partial}${bytes.toString()}`.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      const reply = /^\[indexer-reply\] (\d+) (\d+)$/u.exec(line);
      const request = reply ? requests.get(Number(reply[1])) : undefined;
      if (reply && request) {
        request.indexerMs = Number(reply[2]);
      } else {
        process.stderr.write(`${line}\n`);
      }
    }
  });
  const sendErrors = new Set<(error: unknown) => void>();
  const connection = createIndexerConnection(options, deadlines, {
    kill: () => child.kill(),
    onError: (listener) => {
      child.on('error', listener);
      sendErrors.add(listener);
      return () => {
        child.off('error', listener);
        sendErrors.delete(listener);
      };
    },
    onExit: (listener) => {
      child.on('exit', listener);
      return () => child.off('exit', listener);
    },
    onMessage: (listener) => {
      const timed = (message: unknown) => {
        const id = typeof message === 'object' && message !== null && 'id' in message && message.id;
        const request = typeof id === 'number' ? requests.get(id) : undefined;
        if (request) {
          request.roundTripMs = performance.now() - request.sent;
        }
        listener(message);
      };
      child.on('message', timed);
      return () => child.off('message', timed);
    },
    send: (message) => {
      if ('id' in message && typeof message.id === 'number' && 'op' in message) {
        const payload = 'payload' in message ? message.payload : undefined;
        const maxEvents =
          typeof payload === 'object' && payload !== null && 'maxEvents' in payload
            ? Number(payload.maxEvents)
            : undefined;
        requests.set(message.id, {
          index: requests.size,
          ...(maxEvents === undefined ? {} : { maxEvents }),
          op: String(message.op),
          sent: performance.now(),
        });
      }
      child.send(message, (error) => {
        if (error) {
          for (const listener of sendErrors) {
            listener(error);
          }
        }
      });
    },
  });
  const slowest = (): string => {
    const now = performance.now();
    return (
      [...requests.values()]
        .map((request) => ({ ...request, ms: request.roundTripMs ?? now - request.sent }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 5)
        .map(
          (request) =>
            `#${request.index} ${request.op}: ${Math.round(request.ms)} ms round trip${request.roundTripMs === undefined ? ' (unanswered)' : ''}, ${request.indexerMs ?? 'unknown'} ms in the indexer`
        )
        .join('; ') || 'none'
    );
  };
  /** The step size each `state-catch-up-step` request asked for, in order. */
  const catchUpSteps = (): number[] =>
    [...requests.values()]
      .filter((request) => request.op === 'state-catch-up-step')
      .map((request) => request.maxEvents ?? Number.POSITIVE_INFINITY);
  return { catchUpSteps, port: await connection.ready, slowest };
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'brainstrike-state-backlog-')));
  const dbPath = path.join(root, 'index.sqlite');
  options = {
    dbPath,
    embedding: { indexMode: 'text-only' },
    rootIds: ['canonical'],
    stateProjection: { mode: 'dev', module: producer },
    stateRoot: root,
  };
  const calibration = await openIndexer(options, deadlines);
  const store = await StateStore.open(root, { indexer: createStateStoreIndexer(calibration) });
  const append = (threadId: string, count: number) =>
    store.append(
      Array.from({ length: count }, (_, index) => ({
        event: { runId: 'run-1', text: `garden answer ${index}`, type: 'answer', v: 1 },
        threadId,
      }))
    );
  // One cold thread per entry point, so each meets the whole backlog itself.
  for (const [threadId, backlog] of Object.entries(backlogs)) {
    await append(threadId, backlog);
  }
  await store.close();
  await calibration.close();
  entry = path.join(root, 'timed-indexer-entry.mjs');
  await writeFile(entry, timedEntry);
}, getAdjustedTimeout('performance'));

afterAll(() => rm(root, { force: true, recursive: true }));

const entryPoints: readonly [
  string,
  (port: Port) => Promise<unknown>,
  (served: unknown) => void,
][] = [
  [
    'search',
    (port) => port.searchState({ limit: 5, query: 'garden', threadIds: ['search'] }),
    (hits) => expect(hits).toHaveLength(5),
  ],
  [
    'pending',
    (port) => port.searchStatePending({ limit: 10, profile, threadIds: ['pending'] }),
    (rows) => expect(rows).toHaveLength(10),
  ],
  [
    'coverage',
    (port) => port.searchStateCoverage({ profile, threadIds: ['coverage'] }),
    (coverage) => expect(coverage).toEqual({ embedded: 0, errored: 0, rows: BACKLOG }),
  ],
  [
    'similar',
    (port) =>
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
    async (port) => {
      await port.catchUpState(['rebuild']);
      await port.rebuildState('rebuild');
      return port.stateStats('rebuild');
    },
    (stats) => expect(stats).toMatchObject({ cursor: REBUILD_BACKLOG, docs: REBUILD_BACKLOG }),
  ],
  [
    'gc',
    (port) => port.stateBlobCounts(['gc'], ['a'.repeat(64)]),
    (counts) => expect(counts).toEqual({ ['a'.repeat(64)]: 0 }),
  ],
];

it.each(entryPoints)(
  '%s over a cold backlog is served in bounded steps',
  async (threadId, serve, check) => {
    const { catchUpSteps, port, slowest } = await openTimedIndexer();
    const store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
    try {
      const served = await serve(port);
      const steps = catchUpSteps();
      const backlog = backlogs[threadId] ?? 0;
      expect(
        Math.max(...steps),
        `no catch-up step carries more than ${STATE_CATCH_UP_STEP_EVENTS} events; slowest requests: ${slowest()}`
      ).toBeLessThanOrEqual(STATE_CATCH_UP_STEP_EVENTS);
      expect(steps.length).toBeGreaterThanOrEqual(backlog / STATE_CATCH_UP_STEP_EVENTS);
      check(served);
      expect((await port.stateStats(threadId)).cursor).toBe(backlogs[threadId]);
      // The same worker still answers.
      await expect(port.stateHealth()).resolves.toEqual({ indexerErrors: [] });
    } finally {
      await store.close();
      await port.close();
    }
  },
  getAdjustedTimeout('performance')
);
