// Liveness is the process's exit, never a clock (lifecycle redesign R2/R5, PR D): a slow
// request or a slow startup is load, not death, so nothing retires the process for it.
import { CHILD_SIGNAL_GRACE_MS } from '@brainstrike/state-store';
import { afterEach, expect, it, vi } from 'vitest';
import { createIndexerConnection, type IndexerTransport } from '../src/transport.js';

const dbPath = '/index/index.sqlite';
const options = { dbPath, embedding: { indexMode: 'text-only' }, rootIds: ['/root'] };
const deadlines = { closeMs: 1000 };
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

/** A process that reports ready after `readyMs` and answers each request after `replyMs`. */
function slowProcess(timing: {
  readonly readyMs: number;
  readonly replyMs: number;
  readonly garble?: boolean;
  /** It never answers `close`, so only a kill ends it. */
  readonly ignoresClose?: boolean;
  /** How long its exit takes after a kill. */
  readonly exitAfterKillMs?: number;
  /** How long its exit takes after it answered `close`. */
  readonly exitAfterCloseMs?: number;
  /** Its kill is refused, as Windows refuses to terminate a process that is already exiting. */
  readonly refusesKill?: boolean;
  /** Its close answer never arrives, as when the process exits right after sending it. */
  readonly losesCloseAnswer?: boolean;
  /** The code it exits with after `close` (0 by default). */
  readonly closeExitCode?: number;
  /** Its startup ends with a startup error instead of a ready report. */
  readonly startupError?: boolean;
}) {
  const messages = new Set<(message: unknown) => void>();
  const exits = new Set<(code: number | null) => void>();
  const deliver = (frame: unknown, afterMs: number): void => {
    setTimeout(() => {
      for (const listener of messages) {
        listener(frame);
      }
    }, afterMs);
  };
  let started = false;
  let kills = 0;
  const exit = (afterMs: number, code: number | null): void => {
    setTimeout(() => {
      for (const listener of exits) {
        listener(code);
      }
    }, afterMs);
  };
  const transport: IndexerTransport = {
    kill: () => {
      kills += 1;
      if (timing.refusesKill) {
        return false;
      }
      exit(timing.exitAfterKillMs ?? 0, null);
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
        deliver(
          timing.startupError
            ? {
                error: { code: 'open-failed', message: 'Store did not open.' },
                kind: 'startup-error',
              }
            : { kind: 'ready', value: info },
          timing.readyMs
        );
        return;
      }
      const { id, op } = message as { readonly id: number; readonly op: string };
      if (op === 'close') {
        if (!timing.ignoresClose) {
          if (!timing.losesCloseAnswer) {
            deliver({ id, kind: 'response', ok: true, value: true }, 0);
          }
          exit(timing.exitAfterCloseMs ?? 0, timing.closeExitCode ?? 0);
        }
        return;
      }
      deliver(
        { id: timing.garble ? id + 1000 : id, kind: 'response', ok: true, value: info },
        timing.replyMs
      );
    },
  };
  const stalls: string[] = [];
  transport.onStall = (stage, elapsedMs) => stalls.push(`${stage}:${elapsedMs}`);
  const refusals: unknown[] = [];
  transport.onKillRefused = (cause) => refusals.push(cause);
  return { exitNow: () => exit(0, null), kills: () => kills, refusals, stalls, transport };
}

afterEach(() => {
  vi.useRealTimers();
});

it('answers a request slower than any former deadline and never retires its process', async () => {
  vi.useFakeTimers();
  const process = slowProcess({ readyMs: 0, replyMs: 7000 });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  await vi.advanceTimersByTimeAsync(0);
  const port = await connection.ready;

  const answer = port.info();
  answer.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(7000);

  await expect(answer).resolves.toEqual(info);
  expect(process.kills()).toBe(0);
  expect(connection.exited).toBe(false);
  // The same process keeps serving.
  const next = port.info();
  await vi.advanceTimersByTimeAsync(7000);
  await expect(next).resolves.toEqual(info);
  expect(process.kills()).toBe(0);
});

it('waits for a process that reports ready later than any former startup deadline', async () => {
  vi.useFakeTimers();
  const process = slowProcess({ readyMs: 70_000, replyMs: 0 });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  connection.ready.catch(() => undefined);

  await vi.advanceTimersByTimeAsync(70_000);

  await expect(connection.ready).resolves.toBeDefined();
  expect(process.kills()).toBe(0);
  expect(connection.exited).toBe(false);
  // ADR-0031: a slow startup is neither failed nor reported; it ends at its ready report.
  expect(process.stalls).toEqual([]);
});

it('still retires its process on a protocol fault, and fails that request', async () => {
  vi.useFakeTimers();
  const process = slowProcess({ garble: true, readyMs: 0, replyMs: 0 });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  await vi.advanceTimersByTimeAsync(0);
  const port = await connection.ready;

  const answer = port.info();
  answer.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(CHILD_SIGNAL_GRACE_MS);

  await expect(answer).rejects.toThrow('Unexpected indexer response id');
  expect(process.kills()).toBe(1);
  expect(connection.exited).toBe(true);
});

// R5(b): the close ladder is the connection's one clock. Its escalation is not a failure, and
// the exit after a kill is joined however long it takes.
it('escalates a close the process never answers to one kill, joins the exit, and resolves', async () => {
  vi.useFakeTimers();
  const process = slowProcess({ ignoresClose: true, readyMs: 0, replyMs: 0 });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  await vi.advanceTimersByTimeAsync(0);
  await connection.ready;

  const closing = connection.close();
  await vi.advanceTimersByTimeAsync(deadlines.closeMs + CHILD_SIGNAL_GRACE_MS);

  await expect(closing).resolves.toBeUndefined();
  expect(process.kills()).toBe(1);
  expect(connection.exited).toBe(true);
  expect(process.stalls).toEqual([`close:${deadlines.closeMs}`]);
});

it('keeps joining an exit that is slow after the kill, and never throws while the process lives', async () => {
  vi.useFakeTimers();
  const process = slowProcess({
    exitAfterKillMs: 60_000,
    ignoresClose: true,
    readyMs: 0,
    replyMs: 0,
  });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  await vi.advanceTimersByTimeAsync(0);
  await connection.ready;

  let settled = false;
  const closing = connection.close().finally(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(59_000);
  expect(settled).toBe(false);
  expect(connection.exited).toBe(false);
  expect(process.kills()).toBe(1);

  // The kill came at `closeMs`; its exit lands 60 s after it.
  await vi.advanceTimersByTimeAsync(deadlines.closeMs + 1000);
  await expect(closing).resolves.toBeUndefined();
  expect(connection.exited).toBe(true);
  expect(process.stalls).toEqual([`close:${deadlines.closeMs}`, `exit:${CHILD_SIGNAL_GRACE_MS}`]);
});

it('closes cooperatively with no stall when the process answers and exits', async () => {
  vi.useFakeTimers();
  const process = slowProcess({ readyMs: 0, replyMs: 0 });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  await vi.advanceTimersByTimeAsync(0);
  await connection.ready;
  const closing = connection.close();
  await vi.advanceTimersByTimeAsync(0);
  await expect(closing).resolves.toBeUndefined();
  expect(process.kills()).toBe(0);
  expect(process.stalls).toEqual([]);
});

// ADR-0030: the exit is the close's completion. A process exits right after it answers close,
// and its answer can be lost behind that exit (seen on Windows with the Electron utility).
it('completes a close on the clean exit of a process whose answer never arrived', async () => {
  vi.useFakeTimers();
  const process = slowProcess({ losesCloseAnswer: true, readyMs: 0, replyMs: 0 });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  await vi.advanceTimersByTimeAsync(0);
  await connection.ready;
  const closing = connection.close();
  await vi.advanceTimersByTimeAsync(0);
  await expect(closing).resolves.toBeUndefined();
  expect(process.kills()).toBe(0);
  expect(connection.exited).toBe(true);
});

it('fails a close whose process exits with a failure before it answered', async () => {
  vi.useFakeTimers();
  const process = slowProcess({ closeExitCode: 1, losesCloseAnswer: true, readyMs: 0, replyMs: 0 });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  await vi.advanceTimersByTimeAsync(0);
  await connection.ready;
  const closing = connection.close();
  closing.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  await expect(closing).rejects.toThrow('Indexer close failed; process exit was joined.');
  expect(connection.exited).toBe(true);
});

// ADR-0030: the close window runs from the request to the exit, and a refused kill is not a fault.
it('kills a process that answered close but has not exited when the window ends', async () => {
  vi.useFakeTimers();
  const process = slowProcess({ exitAfterCloseMs: 60_000, readyMs: 0, replyMs: 0 });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  await vi.advanceTimersByTimeAsync(0);
  await connection.ready;

  const closing = connection.close();
  await vi.advanceTimersByTimeAsync(deadlines.closeMs - 1);
  expect(process.kills()).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(process.kills()).toBe(1);
  // The killed process exits on its next timer turn.
  await vi.advanceTimersByTimeAsync(1);
  await expect(closing).resolves.toBeUndefined();
  expect(connection.exited).toBe(true);
  expect(process.stalls).toEqual([`close:${deadlines.closeMs}`]);
});

it('joins the exit of a process whose kill is refused while it is already exiting', async () => {
  vi.useFakeTimers();
  // Answers close, keeps exiting past the window, and Windows refuses the kill meanwhile.
  const process = slowProcess({
    exitAfterCloseMs: deadlines.closeMs + 5000,
    readyMs: 0,
    refusesKill: true,
    replyMs: 0,
  });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  await vi.advanceTimersByTimeAsync(0);
  await connection.ready;

  const closing = connection.close();
  await vi.advanceTimersByTimeAsync(deadlines.closeMs + 5000);

  await expect(closing).resolves.toBeUndefined();
  expect(connection.exited).toBe(true);
  expect(process.kills()).toBe(1);
  expect(process.refusals).toHaveLength(1);
  expect(process.stalls).toEqual([`close:${deadlines.closeMs}`, `exit:${CHILD_SIGNAL_GRACE_MS}`]);
});

it('retires a faulted process whose kill is refused at its own exit, with the fault as the answer', async () => {
  vi.useFakeTimers();
  const process = slowProcess({ garble: true, readyMs: 0, refusesKill: true, replyMs: 0 });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  await vi.advanceTimersByTimeAsync(0);
  const port = await connection.ready;

  const answer = port.info();
  answer.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(CHILD_SIGNAL_GRACE_MS);
  // The refused kill leaves the process owned and joined, not failed or abandoned.
  expect(connection.exited).toBe(false);
  expect(process.refusals).toHaveLength(1);
  expect(process.stalls).toEqual([`exit:${CHILD_SIGNAL_GRACE_MS}`]);

  process.exitNow();
  await vi.advanceTimersByTimeAsync(0);
  await expect(answer).rejects.toThrow('Unexpected indexer response id');
  expect(connection.exited).toBe(true);
  await expect(connection.close()).resolves.toBeUndefined();
});

// ADR-0031: a kill asks nothing and waits on nothing; only a caller that needs the process gone
// joins its exit.
it('kills at once, refuses new requests, and resolves at the exit', async () => {
  vi.useFakeTimers();
  const process = slowProcess({
    exitAfterKillMs: 60_000,
    ignoresClose: true,
    readyMs: 0,
    replyMs: 60_000,
  });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  await vi.advanceTimersByTimeAsync(0);
  const port = await connection.ready;
  const answer = port.info().catch((error: unknown) => error);

  const exit = connection.kill();
  let exited = false;
  void exit.then(() => {
    exited = true;
  });

  expect(process.kills()).toBe(1);
  await expect(port.info()).rejects.toMatchObject({ code: 'indexer-closed' });
  expect(exited).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  await expect(exit).resolves.toBeUndefined();
  // A request in flight at the kill ends with the process.
  expect(await answer).toMatchObject({ code: 'indexer-closed' });
  expect(connection.exited).toBe(true);
  expect(process.kills()).toBe(1);
});

// ADR-0031: a failure is reported at once; the retirement (one kill, the joined exit) goes on, and
// the owner's close joins that exit before anything replaces the process.
it('fails a request on a protocol fault while its killed process has not exited yet', async () => {
  vi.useFakeTimers();
  const process = slowProcess({ exitAfterKillMs: 60_000, garble: true, readyMs: 0, replyMs: 0 });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  await vi.advanceTimersByTimeAsync(0);
  const port = await connection.ready;

  const answer = port.info();
  answer.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  await expect(answer).rejects.toThrow('Unexpected indexer response id');
  expect(process.kills()).toBe(1);
  expect(connection.exited).toBe(false);
  expect(connection.retired).toBe(true);

  let closed = false;
  const closing = connection.close().then(() => {
    closed = true;
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(closed).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000);
  await closing;
  expect(connection.exited).toBe(true);
  expect(process.kills()).toBe(1);
});

it('rejects a failed startup while its killed process has not exited yet', async () => {
  vi.useFakeTimers();
  const process = slowProcess({ readyMs: 0, refusesKill: true, replyMs: 0, startupError: true });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  const ready = connection.ready;
  ready.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);

  await expect(ready).rejects.toMatchObject({ code: 'open-failed' });
  expect(process.kills()).toBe(1);
  expect(connection.exited).toBe(false);
  expect(connection.retired).toBe(true);

  let closed = false;
  const closing = connection.close().then(() => {
    closed = true;
  });
  await vi.advanceTimersByTimeAsync(CHILD_SIGNAL_GRACE_MS * 2);
  expect(closed).toBe(false);
  process.exitNow();
  await vi.advanceTimersByTimeAsync(0);
  await closing;
  expect(connection.exited).toBe(true);
});
