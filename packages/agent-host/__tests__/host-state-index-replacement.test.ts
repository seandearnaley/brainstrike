import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import { createIndexerConnection, type IndexerTransport } from '@brainstrike/indexer/transport';
import { expect, it } from 'vitest';
import { createStateIndexOwner } from '../src/host-state-index.js';

const dbPath = '/state/state-index.sqlite';
const options = { dbPath, embedding: { indexMode: 'text-only' }, rootIds: ['/state'] };
const deadlines = { closeMs: 50, exitMs: 50, requestMs: 20, startupMs: 50 };
const info = {
  dbPath,
  embedding: { indexMode: 'text-only' },
  journalMode: 'wal',
  pid: 1,
  readerQueryOnly: 1,
  storeId: 'a'.repeat(64),
  vecVersion: 'v0.1.9',
  writerThreadId: 1,
};
const healthy = { indexerErrors: [] };

/** How the fake worker answers one `state-health` request: never, served, or refused. */
type Health = 'hang' | 'serve' | 'refuse';

/** A worker that answers each request as listed, or one that never reports ready. */
type Worker = readonly Health[] | 'unstartable';

/**
 * A worker speaking the real indexer frames over the real connection. It answers
 * its requests in `answers` order, repeating the last. A request it never
 * answers meets that connection's own deadline, which retires it.
 */
function worker(answers: Worker): IndexerTransport {
  const exits = new Set<() => void>();
  const messages = new Set<(message: unknown) => void>();
  const deliver = (frame: unknown): void =>
    queueMicrotask(() => {
      for (const listener of messages) {
        listener(frame);
      }
    });
  const exit = (): boolean => {
    queueMicrotask(() => {
      for (const listener of exits) {
        listener();
      }
    });
    return true;
  };
  let started = false;
  let served = 0;
  return {
    kill: exit,
    onError: () => () => {},
    onExit: (listener) => {
      exits.add(listener);
      return () => {
        exits.delete(listener);
      };
    },
    onMessage: (listener) => {
      messages.add(listener);
      return () => {
        messages.delete(listener);
      };
    },
    send: (message) => {
      if (!started) {
        started = true;
        if (answers !== 'unstartable') {
          deliver({ kind: 'ready', value: info });
        }
        return;
      }
      const { id, op } = message as { readonly id: number; readonly op: string };
      const health =
        answers === 'unstartable' ? 'hang' : answers[Math.min(served++, answers.length - 1)];
      if (op === 'close') {
        deliver({ id, kind: 'response', ok: true, value: true });
        exit();
      } else if (health === 'serve') {
        deliver({ id, kind: 'response', ok: true, value: healthy });
      } else if (health === 'refuse') {
        deliver({
          error: { code: 'invalid-request', message: 'refused' },
          id,
          kind: 'response',
          ok: false,
        });
      }
    },
  };
}

/** An owner whose nth worker answers as `workers[n]` says; later workers repeat the last. */
function owner(workers: readonly Worker[]) {
  let starts = 0;
  const created = createStateIndexOwner({
    dbPath,
    start: () => {
      const answers = workers[Math.min(starts, workers.length - 1)] ?? ['serve'];
      starts += 1;
      return createIndexerConnection(options, deadlines, worker(answers));
    },
  });
  return { owner: created, starts: () => starts };
}

it('replaces a worker its request deadline retired; the timed-out request fails typed, unretried', async () => {
  const { owner: index, starts } = owner([['hang'], ['serve']]);
  await index.open();

  const timedOut = await index.port.stateHealth().catch((error: unknown) => error);
  expect(timedOut).toBeInstanceOf(BoundaryFailureError);
  expect((timedOut as BoundaryFailureError).failure).toMatchObject({
    category: 'timeout',
    code: 'state-index.request-timeout',
    kind: 'fault',
  });
  expect(starts()).toBe(1);

  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(2);
  await index.close();
});

it('stops replacing after three retirements in a row with no served request', async () => {
  const { owner: index, starts } = owner([['hang']]);
  await index.open();
  for (let attempt = 0; attempt < 4; attempt++) {
    await expect(index.port.stateHealth()).rejects.toMatchObject({
      failure: { code: 'state-index.request-timeout' },
    });
  }
  expect(starts()).toBe(4);

  // Final: a refusal with a remedy, which nothing re-opens automatically.
  await expect(index.port.stateHealth()).rejects.toMatchObject({
    failure: { category: 'availability', code: 'state-index.retired', kind: 'refusal' },
  });
  expect(starts()).toBe(4);
  await index.close();
});

it('a served request ends the streak, so a later retirement is replaced again', async () => {
  const { owner: index, starts } = owner([
    ['hang'],
    ['hang'],
    ['hang'],
    ['serve', 'hang'],
    ['serve'],
  ]);
  await index.open();
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(index.port.stateHealth()).rejects.toBeInstanceOf(BoundaryFailureError);
  }
  // The third replacement serves, then its next request retires it too.
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  await expect(index.port.stateHealth()).rejects.toBeInstanceOf(BoundaryFailureError);
  // Without the reset this would be the fourth replacement in a row, and refused.
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(5);
  await index.close();
});

it('a replacement that never starts fails typed too, and the next request replaces it again', async () => {
  const { owner: index, starts } = owner([['hang'], 'unstartable', ['serve']]);
  await index.open();
  await expect(index.port.stateHealth()).rejects.toMatchObject({
    failure: { code: 'state-index.request-timeout' },
  });

  const unstarted = await index.port.stateHealth().catch((error: unknown) => error);
  expect(unstarted).toBeInstanceOf(BoundaryFailureError);
  expect((unstarted as BoundaryFailureError).failure).toMatchObject({
    category: 'timeout',
    code: 'state-index.request-timeout',
    kind: 'fault',
  });
  expect(starts()).toBe(2);

  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(3);
  await index.close();
});

it('keeps a live worker that refuses a request, and passes its refusal through untyped', async () => {
  const { owner: index, starts } = owner([['refuse']]);
  await index.open();
  const refused = await index.port.stateHealth().catch((error: unknown) => error);
  expect(refused).not.toBeInstanceOf(BoundaryFailureError);
  expect(refused).toMatchObject({ code: 'invalid-request', name: 'IndexerError' });
  await expect(index.port.stateHealth()).rejects.toMatchObject({ code: 'invalid-request' });
  expect(starts()).toBe(1);
  await index.close();
});
