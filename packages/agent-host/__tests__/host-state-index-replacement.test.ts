import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import { createIndexerConnection, type IndexerTransport } from '@brainstrike/indexer/transport';
import { expect, it, vi } from 'vitest';
import { HOST_STATE_INDEX_DEADLINES } from '../src/host-state-index.js';
import { createStateIndexOwner } from '../src/host-state-index-owner.js';

const dbPath = '/state/state-index.sqlite';
const options = { dbPath, embedding: { indexMode: 'text-only' }, rootIds: ['/state'] };
const deadlines = { closeMs: 50 };
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
 * How a fake worker answers one `state-health` request: served, served late
 * (load, never retired for it), refused by a live worker, with a frame no
 * request asked for (a protocol failure, which retires it), or by exiting.
 */
type Answer = 'serve' | 'slow' | 'refuse' | 'garble' | 'crash';

/** How long a `slow` worker takes to answer: longer than any former request deadline. */
const SLOW_ANSWER_MS = 7000;

/** One fake worker, speaking the real indexer frames over the real connection. */
interface FakeWorker {
  /** Requests are answered in this order; the last answer repeats. */
  readonly answers: readonly Answer[];
  /** The process dies on its own. */
  crash: () => void;
  /** False: it refuses termination, as Windows does for a process already exiting; it exits on `crash`. */
  killable: boolean;
  kills: number;
  /** How its startup ends: ready, a startup error (which retires it), a stale index, or never. */
  readonly starts: 'ready' | 'error' | 'rebuild' | 'never';
}

function fake(
  answers: readonly Answer[],
  overrides: { readonly starts?: FakeWorker['starts']; readonly killable?: boolean } = {}
): FakeWorker {
  return {
    answers,
    crash: () => undefined,
    killable: overrides.killable ?? true,
    kills: 0,
    starts: overrides.starts ?? 'ready',
  };
}

function transport(worker: FakeWorker): IndexerTransport {
  const exits = new Set<(code: number | null) => void>();
  const messages = new Set<(message: unknown) => void>();
  const deliver = (frame: unknown): void =>
    queueMicrotask(() => {
      for (const listener of messages) {
        listener(frame);
      }
    });
  const exit = (code: number | null): void =>
    queueMicrotask(() => {
      for (const listener of exits) {
        listener(code);
      }
    });
  worker.crash = () => exit(1);
  let started = false;
  let served = 0;
  return {
    kill: () => {
      worker.kills += 1;
      if (!worker.killable) {
        return false;
      }
      exit(null);
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
        if (worker.starts === 'ready') {
          deliver({ kind: 'ready', value: info });
        } else if (worker.starts === 'error') {
          deliver({
            error: { code: 'open-failed', message: 'Store did not open.' },
            kind: 'startup-error',
          });
        } else if (worker.starts === 'rebuild') {
          deliver({
            error: { code: 'rebuild-required', message: 'Stored index identity changed.' },
            kind: 'startup-error',
          });
        }
        return;
      }
      const { id, op } = message as { readonly id: number; readonly op: string };
      if (op === 'close') {
        deliver({ id, kind: 'response', ok: true, value: true });
        exit(0);
        return;
      }
      const answer = worker.answers[Math.min(served++, worker.answers.length - 1)];
      if (answer === 'serve') {
        deliver({ id, kind: 'response', ok: true, value: healthy });
      } else if (answer === 'slow') {
        setTimeout(
          () => deliver({ id, kind: 'response', ok: true, value: healthy }),
          SLOW_ANSWER_MS
        );
      } else if (answer === 'refuse') {
        deliver({
          error: { code: 'invalid-request', message: 'refused' },
          id,
          kind: 'response',
          ok: false,
        });
      } else if (answer === 'garble') {
        deliver({ id: id + 1000, kind: 'response', ok: true, value: healthy });
      } else {
        exit(1);
      }
    },
  };
}

/** A start that throws before any worker exists, as `new Worker` can when no thread is free. */
const unspawnable = 'unspawnable';

/** An owner whose nth worker is `workers[n]`; later workers repeat the last. */
function owner(
  workers: readonly (FakeWorker | typeof unspawnable)[],
  workerDeadlines: unknown = deadlines
) {
  let starts = 0;
  const index = createStateIndexOwner({
    dbPath,
    start: () => {
      const worker = workers[Math.min(starts, workers.length - 1)] ?? fake(['serve']);
      starts += 1;
      if (worker === unspawnable) {
        throw new Error('Worker thread could not be created.');
      }
      return createIndexerConnection(options, workerDeadlines, transport(worker));
    },
  });
  return { index, starts: () => starts };
}

const typed = (code: string) => ({ failure: { code, kind: 'fault' } });
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

it('a worker that exits during a request: that request fails typed and unretried, the next is replaced', async () => {
  const { index, starts } = owner([fake(['crash']), fake(['serve'])]);
  await index.open();

  const failed = await index.port.stateHealth().catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(BoundaryFailureError);
  expect(failed).toMatchObject({
    failure: { category: 'availability', code: 'state-index.unavailable', kind: 'fault' },
  });
  expect(starts()).toBe(1);

  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(2);
  await index.close();
});

// Lifecycle redesign PR D: a slow answer is load, not death. The production deadlines retire nothing.
it('serves a request slower than any former deadline from the same worker, with no replacement', async () => {
  vi.useFakeTimers();
  try {
    const { index, starts } = owner([fake(['slow'])], HOST_STATE_INDEX_DEADLINES);
    await index.open();
    const answer = index.port.stateHealth();
    answer.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(SLOW_ANSWER_MS);
    await expect(answer).resolves.toEqual(healthy);
    expect(starts()).toBe(1);
    await index.close();
  } finally {
    vi.useRealTimers();
  }
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

it('a replacement whose startup fails is typed, and the next request replaces it again', async () => {
  const { index, starts } = owner([
    fake(['crash']),
    fake(['serve'], { starts: 'error' }),
    fake(['serve']),
  ]);
  await index.open();
  await expect(index.port.stateHealth()).rejects.toMatchObject(typed('state-index.unavailable'));

  await expect(index.port.stateHealth()).rejects.toMatchObject(typed('state-index.unavailable'));
  expect(starts()).toBe(2);
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(3);
  await index.close();
});

// ADR-0030: Windows refuses to kill a process that is already exiting; its exit is still the only end.
it('a faulted worker whose kill is refused is joined at its exit, and nothing starts beside it', async () => {
  const stuck = fake(['garble'], { killable: false });
  const { index, starts } = owner([stuck, fake(['serve'])]);
  await index.open();
  const failed = index.port.stateHealth();
  failed.catch(() => undefined);
  const waiting = index.port.stateHealth();
  waiting.catch(() => undefined);
  await settle();
  // One kill request, never repeated, and no worker starts beside the one still exiting.
  expect(stuck.kills).toBe(1);
  expect(starts()).toBe(1);

  stuck.crash();
  await expect(failed).rejects.toMatchObject(typed('state-index.unavailable'));
  await expect(waiting).rejects.toMatchObject(typed('state-index.unavailable'));
  expect(starts()).toBe(1);
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(2);
  await index.close();
});

it('a failed replacement whose kill is refused is joined at its exit before the next starts', async () => {
  const replacement = fake(['serve'], { killable: false, starts: 'error' });
  const { index, starts } = owner([fake(['crash']), replacement, fake(['serve'])]);
  await index.open();
  await expect(index.port.stateHealth()).rejects.toBeInstanceOf(BoundaryFailureError);

  const replacing = index.port.stateHealth();
  replacing.catch(() => undefined);
  const waiting = index.port.stateHealth();
  waiting.catch(() => undefined);
  await settle();
  expect(starts()).toBe(2);
  expect(replacement.kills).toBe(1);

  replacement.crash();
  await expect(replacing).rejects.toMatchObject(typed('state-index.unavailable'));
  await expect(waiting).rejects.toMatchObject(typed('state-index.unavailable'));
  expect(starts()).toBe(2);
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(3);
  await index.close();
});

it('stops after three replacements in a row with no request served, refused with a remedy', async () => {
  const { index, starts } = owner([fake(['crash'])]);
  await index.open();
  for (let attempt = 0; attempt < 4; attempt++) {
    await expect(index.port.stateHealth()).rejects.toMatchObject(typed('state-index.unavailable'));
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
    fake(['crash']),
    fake(['crash']),
    fake(['crash']),
    fake(['serve', 'crash']),
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
  const { index, starts } = owner([fake(['crash']), fake(['serve'], { starts: 'never' })]);
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

it('close joins a retired worker whose kill is refused at its exit, and admits nothing meanwhile', async () => {
  const stuck = fake(['garble'], { killable: false });
  const { index, starts } = owner([stuck]);
  await index.open();
  const failed = index.port.stateHealth();
  failed.catch(() => undefined);
  await settle();

  let closed = false;
  const closing = index.close().then(() => {
    closed = true;
  });
  await settle();
  expect(closed).toBe(false);
  await expect(index.port.stateHealth()).rejects.toThrow('Host resource owner is closing');
  expect(stuck.kills).toBe(1);

  stuck.crash();
  await expect(failed).rejects.toBeInstanceOf(BoundaryFailureError);
  await closing;
  // Admission stays fenced: closing never reopens the owner.
  await expect(index.port.stateHealth()).rejects.toThrow('Host resource owner is closing');
  expect(starts()).toBe(1);
});

it('a replacement whose worker cannot even be created fails typed and counts toward the bound', async () => {
  const { index, starts } = owner([fake(['crash']), unspawnable, unspawnable, fake(['serve'])]);
  await index.open();
  await expect(index.port.stateHealth()).rejects.toMatchObject(typed('state-index.unavailable'));

  for (const attempt of [2, 3]) {
    await expect(index.port.stateHealth()).rejects.toMatchObject(typed('state-index.unavailable'));
    expect(starts()).toBe(attempt);
  }
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(4);
  await index.close();
});

it('replacements that cannot be created stop at the bound like any other', async () => {
  const { index, starts } = owner([fake(['crash']), unspawnable]);
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

// The host's `ready` never waits for its index: a request sent while the first worker starts joins that start.
it('a request sent while the first worker is starting is served by that worker', async () => {
  const { index, starts } = owner([fake(['serve'])]);
  const opening = index.open();
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  await opening;
  expect(starts()).toBe(1);
  await index.close();
});

it('a first start that fails rejects open, and the next request is served by a replacement', async () => {
  const { index, starts } = owner([fake(['serve'], { starts: 'error' }), fake(['serve'])]);
  await expect(index.open()).rejects.toMatchObject({ code: 'open-failed' });
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(2);
  await index.close();
});

it('a close while the first worker is still starting ends its open without a failure', async () => {
  const { index, starts } = owner([fake(['serve'], { starts: 'never' })]);
  const opening = index.open();
  await index.close();
  await expect(opening).resolves.toBeUndefined();
  await expect(index.port.stateHealth()).rejects.toThrow('Host resource owner is closing');
  expect(starts()).toBe(1);
});

// ADR-0031: a request never waits on a retired worker's exit.
it('a request after a faulted worker that has not exited is refused at once, and nothing starts beside it', async () => {
  const stuck = fake(['garble'], { killable: false });
  const { index, starts } = owner([stuck, fake(['serve'])]);
  await index.open();
  await expect(index.port.stateHealth()).rejects.toMatchObject(typed('state-index.unavailable'));

  await expect(index.port.stateHealth()).rejects.toMatchObject(typed('state-index.unavailable'));
  expect(stuck.kills).toBe(1);
  expect(starts()).toBe(1);

  stuck.crash();
  await settle();
  await expect(index.port.stateHealth()).resolves.toEqual(healthy);
  expect(starts()).toBe(2);
  await index.close();
});

// ADR-0031: a stale index is refused at once; it is rebuilt by the first request after its worker's exit.
it('a start that needs a rebuild is refused at once, and the first request after its exit rebuilds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-index-rebuild-'));
  try {
    const stalePath = join(dir, 'state-index.sqlite');
    writeFileSync(stalePath, 'stale');
    const stale = fake(['serve'], { killable: false, starts: 'rebuild' });
    const workers = [stale, fake(['serve'])];
    let starts = 0;
    const index = createStateIndexOwner({
      dbPath: stalePath,
      start: () => {
        const worker = workers[Math.min(starts, workers.length - 1)] ?? fake(['serve']);
        starts += 1;
        return createIndexerConnection(options, deadlines, transport(worker));
      },
    });
    await expect(index.open()).rejects.toMatchObject({ code: 'rebuild-required' });
    // Its worker has not exited: nothing is removed or started beside it.
    await expect(index.port.stateHealth()).rejects.toMatchObject(typed('state-index.unavailable'));
    expect(existsSync(stalePath)).toBe(true);
    expect(starts).toBe(1);

    stale.crash();
    await settle();
    await expect(index.port.stateHealth()).resolves.toEqual(healthy);
    expect(existsSync(stalePath)).toBe(false);
    expect(starts).toBe(2);
    await index.close();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
