// Liveness is the process's exit, never a clock (lifecycle redesign R2/R5, PR D): a slow
// request or a slow startup is load, not death, so nothing retires the process for it.
import { afterEach, expect, it, vi } from 'vitest';
import {
  createIndexerConnection,
  INDEXER_STARTUP_STALL_WARN_MS,
  type IndexerTransport,
} from '../src/transport.js';

const dbPath = '/index/index.sqlite';
const options = { dbPath, embedding: { indexMode: 'text-only' }, rootIds: ['/root'] };
const deadlines = { closeMs: 1000, exitMs: 1000 };
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
  /** How long its exit takes after it answers `close`. */
  readonly exitAfterCloseMs?: number;
  /** Windows refuses to terminate a process that is already exiting. */
  readonly refusesKill?: boolean;
}) {
  const messages = new Set<(message: unknown) => void>();
  const exits = new Set<() => void>();
  const deliver = (frame: unknown, afterMs: number): void => {
    setTimeout(() => {
      for (const listener of messages) {
        listener(frame);
      }
    }, afterMs);
  };
  let started = false;
  let kills = 0;
  const exit = (afterMs: number): void => {
    setTimeout(() => {
      for (const listener of exits) {
        listener();
      }
    }, afterMs);
  };
  const transport: IndexerTransport = {
    kill: () => {
      kills += 1;
      if (timing.refusesKill) {
        return false;
      }
      exit(timing.exitAfterKillMs ?? 0);
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
        deliver({ kind: 'ready', value: info }, timing.readyMs);
        return;
      }
      const { id, op } = message as { readonly id: number; readonly op: string };
      if (op === 'close') {
        if (!timing.ignoresClose) {
          deliver({ id, kind: 'response', ok: true, value: true }, 0);
          exit(timing.exitAfterCloseMs ?? 0);
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
  return { kills: () => kills, stalls, transport };
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
  // R3: the stall is logged once, never failed.
  expect(process.stalls).toEqual([`startup:${INDEXER_STARTUP_STALL_WARN_MS}`]);
});

it('logs no stall for a startup that reports ready in time', async () => {
  vi.useFakeTimers();
  const process = slowProcess({ readyMs: INDEXER_STARTUP_STALL_WARN_MS - 1, replyMs: 0 });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  await vi.advanceTimersByTimeAsync(INDEXER_STARTUP_STALL_WARN_MS * 2);
  await expect(connection.ready).resolves.toBeDefined();
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
  await vi.advanceTimersByTimeAsync(deadlines.exitMs);

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
  await vi.advanceTimersByTimeAsync(deadlines.closeMs + deadlines.exitMs);

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
  expect(process.stalls).toEqual([`close:${deadlines.closeMs}`, `exit:${deadlines.exitMs}`]);
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

// Queue run 40164820640: an indexer that answered close took longer than `exitMs` to exit on a
// loaded Windows runner, the kill was refused because it was already exiting, and the native
// index stayed blocked until quit.
it('joins the late exit of a process that answered close, and never kills it', async () => {
  vi.useFakeTimers();
  const process = slowProcess({
    exitAfterCloseMs: 5000,
    readyMs: 0,
    refusesKill: true,
    replyMs: 0,
  });
  const connection = createIndexerConnection(options, deadlines, process.transport);
  await vi.advanceTimersByTimeAsync(0);
  await connection.ready;

  const closing = connection.close();
  closing.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(5000);

  await expect(closing).resolves.toBeUndefined();
  expect(process.kills()).toBe(0);
  expect(connection.exited).toBe(true);
  expect(process.stalls).toEqual([`exit:${deadlines.exitMs}`]);
});
