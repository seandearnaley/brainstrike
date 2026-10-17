import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import { createIndexerConnection, type IndexerTransport } from '@brainstrike/indexer/transport';
import { expect, it, vi } from 'vitest';
import { createStateIndexOwner } from '../src/host-state-index-owner.js';

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

/**
 * How a fake worker answers one `state-health` request: never (its deadline
 * retires it), served, refused by a live worker, or with a frame no request
 * asked for (a protocol failure, which also retires it).
 */
type Answer = 'hang' | 'serve' | 'refuse' | 'garble';

/** One fake worker, speaking the real indexer frames over the real connection. */
interface FakeWorker {
  /** Requests are answered in this order; the last answer repeats. */
  readonly answers: readonly Answer[];
  /** The process dies on its own. */
  crash: () => void;
  /** False: it refuses termination, so its exit cannot be joined. */
  killable: boolean;
  kills: number;
  /** False: it never reports ready, so its startup deadline retires it. */
  readonly starts: boolean;
}

function fake(
  answers: readonly Answer[],
  overrides: { readonly starts?: boolean; readonly killable?: boolean } = {}
): FakeWorker {
  return {
    answers,
    crash: () => undefined,
    killable: overrides.killable ?? true,
    kills: 0,
    starts: overrides.starts ?? true,
  };
}

function transport(worker: FakeWorker): IndexerTransport {
  const exits = new Set<() => void>();
  const messages = new Set<(message: unknown) => void>();
  const deliver = (frame: unknown): void =>
    queueMicrotask(() => {
      for (const listener of messages) {
        listener(frame);
      }
    });
  const exit = (): void =>
    queueMicrotask(() => {
      for (const listener of exits) {
        listener();
      }
    });
  worker.crash = exit;
  let started = false;
  let served = 0;
  return {
    kill: () => {
      worker.kills += 1;
      if (!worker.killable) {
        return false;
      }
      exit();
      return true;
    },
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
        if (worker.starts) {
          deliver({ kind: 'ready', value: info });
        }
        return;
      }
      const { id, op } = message as { readonly id: number; readonly op: string };
      if (op === 'close') {
        deliver({ id, kind: 'response', ok: true, value: true });
        exit();
        return;
      }
      const answer = worker.answers[Math.min(served++, worker.answers.length - 1)];
      if (answer === 'serve') {
        deliver({ id, kind: 'response', ok: true, value: healthy });
      } else if (answer === 'refuse') {
        deliver({
          error: { code: 'invalid-request', message: 'refused' },
          id,
          kind: 'response',
          ok: false,
        });
      } else if (answer === 'garble') {
        deliver({ id: id + 1000, kind: 'response', ok: true, value: healthy });
      }
    },
  };
}

/** A start that throws before any worker exists, as `new Worker` can when no thread is free. */
const unspawnable = 'unspawnable';

/** An owner whose nth worker is `workers[n]`; later workers repeat the last. */
function owner(workers: readonly (FakeWorker | typeof unspawnable)[]) {
  let starts = 0;
  const index = createStateIndexOwner({
    dbPath,
    start: () => {
      const worker = workers[Math.min(starts, workers.length - 1)] ?? fake(['serve']);
      starts += 1;
      if (worker === unspawnable) {
        throw new Error('Worker thread could not be created.');
      }
      return createIndexerConnection(options, deadlines, transport(worker));
    },
  });
  return { index, starts: () => starts };
}

const typed = (code: string) => ({ failure: { code, kind: 'fault' } });
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

it('a request deadline retires its worker: that request fails typed and unretried, the next is replaced', async () => {
  const { index, starts } = owner([fake(['hang']), fake(['serve'])]);
  await index.open();

  const timedOut = await index.port.stateHealth().catch((error: unknown) => error);
  expect(timedOut).toBeInstanceOf(BoundaryFailureError);
  expect(timedOut).toMatchObject({
    failure: { category: 'timeout', code: 'state-index.request-timeout', kind: 'fault' },
  });
  expect(starts()).toBe(1);

  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(2);
  await index.close();
});

it('a protocol failure retires its worker the same way', async () => {
  const { index, starts } = owner([fake(['garble']), fake(['serve'])]);
  await index.open();
  await expect(index.port.stateHealth()).rejects.toMatchObject(typed('state-index.unavailable'));
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(2);
  await index.close();
});

it('a worker that exits between requests is replaced before any request reaches it', async () => {
  const first = fake(['serve']);
  const { index, starts } = owner([first, fake(['serve'])]);
  await index.open();
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);

  first.crash();
  await settle();
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(2);
  await index.close();
});

it('a replacement that never starts fails typed, and the next request replaces it again', async () => {
  const { index, starts } = owner([
    fake(['hang']),
    fake(['serve'], { starts: false }),
    fake(['serve']),
  ]);
  await index.open();
  await expect(index.port.stateHealth()).rejects.toMatchObject(
    typed('state-index.request-timeout')
  );

  await expect(index.port.stateHealth()).rejects.toMatchObject(
    typed('state-index.request-timeout')
  );
  expect(starts()).toBe(2);
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(3);
  await index.close();
});

it('a timed-out worker whose exit cannot be joined is never asked again, and nothing starts beside it', async () => {
  const stuck = fake(['hang'], { killable: false });
  const { index, starts } = owner([stuck, fake(['serve'])]);
  await index.open();
  await expect(index.port.stateHealth()).rejects.toMatchObject(typed('state-index.unavailable'));
  const killed = stuck.kills;

  // The next request joins its exit (another termination attempt), not its failed client.
  await expect(index.port.stateHealth()).rejects.toMatchObject(typed('state-index.unavailable'));
  expect(stuck.kills).toBeGreaterThan(killed);
  expect(starts()).toBe(1);

  stuck.killable = true;
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(2);
  await index.close();
});

it('a failed replacement whose exit cannot be joined stays owned; nothing starts beside it', async () => {
  const replacement = fake(['serve'], { killable: false, starts: false });
  const { index, starts } = owner([fake(['hang']), replacement, fake(['serve'])]);
  await index.open();
  await expect(index.port.stateHealth()).rejects.toBeInstanceOf(BoundaryFailureError);

  await expect(index.port.stateHealth()).rejects.toBeInstanceOf(BoundaryFailureError);
  expect(starts()).toBe(2);
  await expect(index.port.stateHealth()).rejects.toMatchObject(typed('state-index.unavailable'));
  expect(starts()).toBe(2);

  replacement.killable = true;
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(3);
  await index.close();
});

it('stops after three replacements in a row with no request served, refused with a remedy', async () => {
  const { index, starts } = owner([fake(['hang'])]);
  await index.open();
  for (let attempt = 0; attempt < 4; attempt++) {
    await expect(index.port.stateHealth()).rejects.toMatchObject(
      typed('state-index.request-timeout')
    );
  }
  expect(starts()).toBe(4);

  // Final: a refusal, which nothing re-opens automatically.
  await expect(index.port.stateHealth()).rejects.toMatchObject({
    failure: {
      category: 'availability',
      code: 'state-index.retired',
      kind: 'refusal',
      remedy: 'Restart BrainStrike.',
    },
  });
  expect(starts()).toBe(4);
  await index.close();
});

it('a served request ends the streak, so a later retirement is replaced again', async () => {
  const { index, starts } = owner([
    fake(['hang']),
    fake(['hang']),
    fake(['hang']),
    fake(['serve', 'hang']),
    fake(['serve']),
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

it('keeps a live worker that refuses a request, and passes its refusal through untyped', async () => {
  const { index, starts } = owner([fake(['refuse'])]);
  await index.open();
  const refused = await index.port.stateHealth().catch((error: unknown) => error);
  expect(refused).not.toBeInstanceOf(BoundaryFailureError);
  expect(refused).toMatchObject({ code: 'invalid-request', name: 'IndexerError' });
  await expect(index.port.stateHealth()).rejects.toMatchObject({ code: 'invalid-request' });
  expect(starts()).toBe(1);
  await index.close();
});

it('close stops a replacement still starting, and nothing starts after it', async () => {
  const { index, starts } = owner([fake(['hang']), fake(['serve'], { starts: false })]);
  await index.open();
  await expect(index.port.stateHealth()).rejects.toBeInstanceOf(BoundaryFailureError);

  const replacing = index.port.stateHealth();
  replacing.catch(() => undefined);
  await vi.waitFor(() => expect(starts()).toBe(2));
  await index.close();
  await expect(replacing).rejects.toBeDefined();
  await expect(index.port.stateHealth()).rejects.toThrow('Host resource owner is closing');
  expect(starts()).toBe(2);
});

it('close keeps ownership of a retired worker it cannot join, reports it, and retries on the next close', async () => {
  const stuck = fake(['hang'], { killable: false });
  const { index, starts } = owner([stuck]);
  await index.open();
  await expect(index.port.stateHealth()).rejects.toBeInstanceOf(BoundaryFailureError);

  await expect(index.close()).rejects.toBeDefined();
  await expect(index.port.stateHealth()).rejects.toThrow('Host resource owner is closing');
  const killed = stuck.kills;

  // The worker can now be stopped: the next close retries the join and succeeds.
  stuck.killable = true;
  await expect(index.close()).resolves.toBeUndefined();
  expect(stuck.kills).toBeGreaterThan(killed);
  // Admission stays fenced: closing never reopens the owner.
  await expect(index.port.stateHealth()).rejects.toThrow('Host resource owner is closing');
  expect(starts()).toBe(1);
});

it('a replacement whose worker cannot even be created fails typed and counts toward the bound', async () => {
  const { index, starts } = owner([fake(['hang']), unspawnable, unspawnable, fake(['serve'])]);
  await index.open();
  await expect(index.port.stateHealth()).rejects.toMatchObject(
    typed('state-index.request-timeout')
  );

  for (const attempt of [2, 3]) {
    await expect(index.port.stateHealth()).rejects.toMatchObject(typed('state-index.unavailable'));
    expect(starts()).toBe(attempt);
  }
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(4);
  await index.close();
});

it('replacements that cannot be created stop at the bound like any other', async () => {
  const { index, starts } = owner([fake(['hang']), unspawnable]);
  await index.open();
  await expect(index.port.stateHealth()).rejects.toBeInstanceOf(BoundaryFailureError);
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(index.port.stateHealth()).rejects.toMatchObject(typed('state-index.unavailable'));
  }
  expect(starts()).toBe(4);
  await expect(index.port.stateHealth()).rejects.toMatchObject({
    failure: { code: 'state-index.retired', kind: 'refusal' },
  });
  expect(starts()).toBe(4);
  await index.close();
});
