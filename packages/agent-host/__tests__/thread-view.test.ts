import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import { expect, test } from 'vitest';
import { z } from 'zod';
import { HostLogRowSchema } from '../src/protocol.js';
import { CommittedThreadSession, CommittedThreadView, foldHostRuns } from '../src/thread-view.js';

const rows = z.array(HostLogRowSchema).parse(recording);
const threadId = rows[0]?.threadId;
if (!threadId) {
  throw new Error('The runtime recording has no thread');
}

test('recorded approved host run folds into completed output with no open approval', () => {
  const [run] = foldHostRuns(rows);
  const text = rows
    .flatMap(({ event }) => {
      if (
        event.type !== 'stream.chunk' ||
        !event.chunk ||
        typeof event.chunk !== 'object' ||
        Array.isArray(event.chunk)
      ) {
        return [];
      }
      return event.chunk['type'] === 'text-delta' ? [event.chunk['text']] : [];
    })
    .join('');
  expect(run?.status).toBe('completed');
  expect(run?.text).toBe(text);
  expect(run?.approvals).toEqual([]);
  expect(run?.results).toEqual(
    rows.map((row) => row.event).filter((item) => item.type === 'effect.finished')
  );
});

test('recorded pause stays visible until its committed response arrives', () => {
  const response = rows.findIndex((row) => row.event.type === 'interaction.responded');
  const requested = rows.find((row) => row.event.type === 'interaction.requested')?.event;
  expect(foldHostRuns(rows.slice(0, response))[0]?.approvals).toEqual([requested]);
  expect(foldHostRuns(rows.slice(0, response + 1))[0]?.approvals).toEqual([]);
});

test('reordered replay/live overlap displays only a contiguous committed prefix once', () => {
  const view = new CommittedThreadView(threadId);
  let publications = 0;
  view.subscribe(() => {
    publications += 1;
  });
  view.accept(rows.slice(1).toReversed());
  expect(view.getSnapshot()).toEqual([]);
  view.accept(rows);
  expect(view.getSnapshot()).toEqual(rows);
  view.accept(rows);
  expect(view.getSnapshot()).toEqual(rows);
  expect(publications).toBe(1);
});

test('another thread cannot enter the selected committed view', () => {
  const view = new CommittedThreadView(threadId);
  view.accept(rows.map((row) => ({ ...row, threadId: 'other-recording' })));
  expect(view.getSnapshot()).toEqual([]);
});

type SessionClient = ConstructorParameters<typeof CommittedThreadSession>[0];
type Row = (typeof rows)[number];

/** The session's actual client surface: the live row feed, requests and closure. */
function replayClient(): {
  readonly client: SessionClient;
  readonly live: (row: Row) => void;
  readonly replay: PromiseWithResolvers<{ rows: Row[] }>;
} {
  const listeners = new Set<(row: Row) => void>();
  const replay = Promise.withResolvers<{ rows: Row[] }>();
  const request = (method: string): Promise<unknown> =>
    method === 'log/subscribe' ? replay.promise : Promise.resolve({ unsubscribed: true });
  const client: SessionClient = {
    closed: new Promise<void>(() => undefined),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request: request as SessionClient['request'],
  };
  return {
    client,
    live: (row) => {
      for (const listener of listeners) {
        listener(row);
      }
    },
    replay,
  };
}

test('a session is loading until its replay arrives, and names the replayed boundary', async () => {
  const { client, live, replay } = replayClient();
  const session = new CommittedThreadSession(client, threadId);
  const disconnect = session.connect();
  expect(session.getSnapshot()).toMatchObject({ isLoading: true, replayedThrough: undefined });
  const replayed = rows.slice(0, -1);
  const tail = rows.at(-1);
  if (!tail) {
    throw new Error('The runtime recording is empty');
  }
  // Committed after the replay's read: it is live, though it arrives first.
  live(tail);
  expect(session.getSnapshot().rows).toEqual([]);
  replay.resolve({ rows: replayed });
  await replay.promise;
  await Promise.resolve();
  expect(session.getSnapshot()).toMatchObject({
    isLoading: false,
    replayedThrough: replayed.at(-1)?.seq,
    rows,
  });
  disconnect();
});

test('a refused replay ends loading with its error and no replayed boundary', async () => {
  const { client, replay } = replayClient();
  const session = new CommittedThreadSession(client, threadId);
  session.connect();
  replay.reject(new Error('Unknown thread'));
  await replay.promise.catch(() => undefined);
  await Promise.resolve();
  expect(session.getSnapshot()).toMatchObject({
    error: 'Unknown thread',
    isLoading: false,
    replayedThrough: undefined,
  });
});
