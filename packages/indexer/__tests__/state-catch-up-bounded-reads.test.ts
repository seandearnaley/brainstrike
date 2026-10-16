// Every request on the state index stays bounded: a read that would catch its
// threads up first sends that catch-up as bounded steps, so the read request
// itself never carries a backlog past its connection's deadline.
import { expect, it } from 'vitest';
import { STATE_CATCH_UP_STEP_EVENTS } from '../src/contracts.js';
import { createIndexerConnection, type IndexerTransport } from '../src/transport.js';

const dbPath = '/state/state-index.sqlite';
const profile = {
  dimensions: 384,
  distance: 'cosine',
  modelId: 'text-embedding-3-small',
  provider: 'openai',
} as const;
const replies: Readonly<Record<string, unknown>> = {
  'state-gc-check': {},
  'state-rebuild': true,
  'state-search': [],
  'state-search-coverage': { embedded: 0, errored: 0, rows: 0 },
  'state-search-pending': [],
  'state-search-similar': [],
};

/**
 * A worker whose backlog takes `steps` catch-up steps; it records every request it
 * receives. Its first `behind` reads are refused as behind, as when an append lands
 * between the last step and the read, leaving one more step to take.
 */
function worker(steps: number, behind = 0) {
  const sent: { readonly op: string; readonly payload: unknown }[] = [];
  const messages = new Set<(message: unknown) => void>();
  let remaining = steps;
  let refusals = behind;
  let started = false;
  const transport: IndexerTransport = {
    kill: () => true,
    onError: () => () => {},
    onExit: () => () => {},
    onMessage: (listener) => {
      messages.add(listener);
      return () => {
        messages.delete(listener);
      };
    },
    send: (message) => {
      const answer = (frame: unknown): void =>
        queueMicrotask(() => {
          for (const listener of messages) {
            listener(frame);
          }
        });
      if (!started) {
        started = true;
        answer({
          kind: 'ready',
          value: {
            dbPath,
            embedding: { indexMode: 'text-only' },
            journalMode: 'wal',
            pid: 1,
            readerQueryOnly: 1,
            storeId: 'a'.repeat(64),
            vecVersion: 'v0.1.9',
            writerThreadId: 1,
          },
        });
        return;
      }
      const { id, op, payload } = message as {
        readonly id: number;
        readonly op: string;
        readonly payload: unknown;
      };
      sent.push({ op, payload });
      if (op === 'state-catch-up-step') {
        remaining = Math.max(0, remaining - 1);
        answer({ id, kind: 'response', ok: true, value: remaining === 0 });
      } else if (refusals > 0) {
        refusals -= 1;
        remaining = 1;
        answer({
          error: { code: 'state-behind', message: 'behind' },
          id,
          kind: 'response',
          ok: false,
        });
      } else {
        answer({ id, kind: 'response', ok: true, value: replies[op] });
      }
    },
  };
  const port = createIndexerConnection(
    { dbPath, embedding: { indexMode: 'text-only' }, rootIds: ['/state'] },
    { closeMs: 50, exitMs: 50, requestMs: 1000, startupMs: 1000 },
    transport
  ).ready;
  return { port, sent };
}

const step = (threads: readonly string[]) => ({
  op: 'state-catch-up-step',
  payload: { maxEvents: STATE_CATCH_UP_STEP_EVENTS, threads },
});

const reads = {
  'state-gc-check': (port) => port.stateBlobCounts(['t1', 't2'], []),
  'state-search': (port) => port.searchState({ limit: 5, query: 'plan', threadIds: ['t1', 't2'] }),
  'state-search-coverage': (port) => port.searchStateCoverage({ profile, threadIds: ['t1', 't2'] }),
  'state-search-pending': (port) =>
    port.searchStatePending({ limit: 5, profile, threadIds: ['t1', 't2'] }),
  'state-search-similar': (port) =>
    port.searchStateSimilar({
      limit: 5,
      profile,
      threadIds: ['t1', 't2'],
      threshold: 0.5,
      vector: [0.1, 0.2],
    }),
} satisfies Record<string, (port: Awaited<ReturnType<typeof worker>['port']>) => Promise<unknown>>;

it.each(Object.entries(reads))(
  '%s catches its threads up in bounded steps before the read request',
  async (op, read) => {
    const { port, sent } = worker(3);
    await read(await port);
    expect(sent.map(({ op: name }) => name)).toEqual([
      'state-catch-up-step',
      'state-catch-up-step',
      'state-catch-up-step',
      op,
    ]);
    expect(sent.slice(0, 3)).toEqual([step(['t1', 't2']), step(['t1', 't2']), step(['t1', 't2'])]);
  }
);

it('a catch-up is only bounded steps, never one unbounded request', async () => {
  const { port, sent } = worker(2);
  await (await port).catchUpState(['t1']);
  expect(sent).toEqual([step(['t1']), step(['t1'])]);
});

it('a rebuild resets the thread, then re-projects it in bounded steps', async () => {
  const { port, sent } = worker(2);
  await (await port).rebuildState('t1');
  expect(sent).toEqual([{ op: 'state-rebuild', payload: 't1' }, step(['t1']), step(['t1'])]);
});

it.each(Object.entries(reads))(
  '%s refused as behind (an append raced its last step) steps again and is served',
  async (op, read) => {
    const { port, sent } = worker(1, 1);
    await read(await port);
    expect(sent.map(({ op: name }) => name)).toEqual([
      'state-catch-up-step',
      op,
      'state-catch-up-step',
      op,
    ]);
  }
);
