// Every entry point that catches the state index up, over a cold backlog far
// past one catch-up step and behind a request deadline half that backlog's
// projection in one request: each is served, and the worker lives.
import { fork } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createStateStoreIndexer,
  openIndexer,
  STATE_CATCH_UP_STEP_EVENTS,
} from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { StateStore } from '@brainstrike/state-store';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createIndexerConnection } from '../dist/transport.js';

type Port = Awaited<ReturnType<typeof openIndexer>>;

/** 60 steps. */
const BACKLOG = STATE_CATCH_UP_STEP_EVENTS * 60;
/**
 * 20 steps, not 60: overwrite steps grow with rebuild progress (BST-2153); this
 * case proves stepping and the deadline, not that growth.
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
 * A case's request deadline is its own backlog projected in one request,
 * measured in this run, divided by this: coverage and a busy runner stretch the
 * work so far that no fixed deadline fits every runner. Carrying the backlog in
 * one request misses the deadline twice over, while a case's largest request
 * measured about a tenth of that one request, and a sixth at worst, idle and
 * under load (BST-2214). The deadline comes from that long request rather than
 * a few short step samples, which load moves apart from it, and each case has
 * its own: one deadline for every case had to sit both above a rebuild's
 * overwrite steps (10 to 30 fresh steps) and below the fresh backlog in one
 * request (about 55).
 */
const DEADLINES_PER_BACKLOG = 2;
const calibrationDeadlines = { closeMs: 5000, exitMs: 5000, requestMs: 120_000, startupMs: 5000 };
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
/** The fresh backlog, and the rebuild's overwrite, each projected in one request. */
let oneRequestMs: { readonly fresh: number; readonly rebuild: number };

/** One request to a measured indexer: its order, op and timings. */
interface TimedRequest {
  readonly index: number;
  indexerMs?: number;
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
await import(${JSON.stringify(new URL('../dist/process-entry.js', import.meta.url).href)});
`;

/**
 * openIndexer's own fork and connection, with the slowest requests it sent, so
 * a missed deadline names its request.
 */
async function openTimedIndexer(deadlines: unknown) {
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
        requests.set(message.id, {
          index: requests.size,
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
  return { port: await connection.ready, slowest };
}

async function elapsed(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await work();
  return performance.now() - started;
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
  const calibration = await openIndexer(options, calibrationDeadlines);
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
  await append('whole', BACKLOG);
  await append('rewrite', REBUILD_BACKLOG);
  const whole = await elapsed(() => calibration.catchUpStateStep(['whole'], BACKLOG));
  await calibration.catchUpStateStep(['rewrite'], REBUILD_BACKLOG);
  // What state-rebuild does to a thread without vectors (state-event-store.ts):
  // its cursor goes, so the next catch-up overwrites every row.
  const db = openConnection(dbPath);
  try {
    db.prepare('DELETE FROM state_thread_cursors WHERE thread_id=?').run('rewrite');
  } finally {
    db.close();
  }
  const rewrite = await elapsed(() => calibration.catchUpStateStep(['rewrite'], REBUILD_BACKLOG));
  oneRequestMs = { fresh: whole, rebuild: rewrite };
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
  '%s over a cold backlog is served, every request inside the deadline',
  async (threadId, serve, check) => {
    const rebuild = threadId === 'rebuild';
    const oneRequest = rebuild ? oneRequestMs.rebuild : oneRequestMs.fresh;
    const requestMs = Math.ceil(oneRequest / DEADLINES_PER_BACKLOG);
    const { port, slowest } = await openTimedIndexer({ ...calibrationDeadlines, requestMs });
    const store = await StateStore.open(root, { indexer: createStateStoreIndexer(port) });
    try {
      const served = await serve(port).catch((error: unknown) => {
        throw new Error(
          `requestMs ${requestMs} (${rebuild ? 'rebuild' : 'backlog'} in one request ${Math.round(oneRequest)} ms); slowest requests: ${slowest()}`,
          { cause: error }
        );
      });
      check(served);
      expect((await port.stateStats(threadId)).cursor).toBe(backlogs[threadId]);
      // Retirement would have failed the connection: the same worker still answers.
      await expect(port.stateHealth()).resolves.toEqual({ indexerErrors: [] });
    } finally {
      await store.close();
      await port.close();
    }
  },
  getAdjustedTimeout('performance')
);
