// Liveness is the process's exit, never a clock (lifecycle redesign R2/R5, PR D): a slow
// request or a slow startup is load, not death, so nothing retires the process for it.
import { afterEach, expect, it, vi } from 'vitest';
import { createIndexerConnection, type IndexerTransport } from '../src/transport.js';

const dbPath = '/index/index.sqlite';
const options = { dbPath, embedding: { indexMode: 'text-only' }, rootIds: ['/root'] };
const deadlines = { closeMs: 1000, exitMs: 1000, requestMs: 5000, startupMs: 60_000 };
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
function slowProcess(timing: { readonly readyMs: number; readonly replyMs: number }) {
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
  const transport: IndexerTransport = {
    kill: () => {
      kills += 1;
      queueMicrotask(() => {
        for (const listener of exits) {
          listener();
        }
      });
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
        deliver({ id, kind: 'response', ok: true, value: true }, 0);
        return;
      }
      deliver({ id, kind: 'response', ok: true, value: info }, timing.replyMs);
    },
  };
  return { kills: () => kills, transport };
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
});
