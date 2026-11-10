import { beforeEach, expect, it, vi } from 'vitest';
import { runIndexerProcess } from '../src/process-core.js';

interface FakeWriter {
  emit(event: string, ...args: unknown[]): boolean;
}

const writers = vi.hoisted(() => ({
  closed: vi.fn(),
  current: undefined as FakeWriter | undefined,
  terminated: vi.fn(),
}));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      private exited = false;
      constructor() {
        super();
        writers.current = this;
      }
      // The writer's cooperative close: it answers, closes its database and exits.
      postMessage(message: { id: number; op: string }) {
        if (message.op === 'close') {
          writers.closed();
          queueMicrotask(() => {
            this.emit('message', { id: message.id, kind: 'response', ok: true, value: true });
            this.exit();
          });
        }
      }
      // Only a writer still running is torn down by a terminate; one that exited is unaffected.
      terminate() {
        if (!this.exited) {
          writers.terminated();
        }
        this.exit();
        return Promise.resolve(0);
      }
      private exit() {
        if (!this.exited) {
          this.exited = true;
          this.emit('exit', 0);
        }
      }
    },
  };
});

beforeEach(() => {
  writers.closed.mockClear();
  writers.terminated.mockClear();
  writers.current = undefined;
});

function startProcess() {
  const messages: object[] = [];
  const finish = vi.fn();
  let receive: (message: unknown) => void = () => {
    throw new Error('No message listener');
  };
  const completed = runIndexerProcess(
    {
      dbPath: '/tmp/unused-indexer-close.sqlite',
      stateProjection: { mode: 'dev', module: 'file:///unused-producer.mjs' },
      stateRoot: '/tmp',
    },
    {
      finish,
      onMessage: (listener) => {
        receive = listener;
      },
      send: (message) => {
        messages.push(message);
      },
    }
  );
  const writer = writers.current;
  if (!writer) {
    throw new Error('The indexer process started no writer');
  }
  return { completed, finish, messages, receive: (message: unknown) => receive(message), writer };
}

const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

it('lets a writer still opening its database finish, then closes it (BST-2472)', async () => {
  const run = startProcess();
  run.receive({ id: 1, op: 'close', payload: null });
  await settle();
  // Terminating now could land while the writer loads the SQLite add-on, which aborts the process.
  expect(writers.terminated).not.toHaveBeenCalled();
  expect(run.messages).toEqual([]);

  run.writer.emit('message', {
    kind: 'ready',
    value: {
      dbPath: '/tmp/unused-indexer-close.sqlite',
      journalMode: 'wal',
      pid: 1,
      storeId: 'a'.repeat(64),
      writerThreadId: 1,
    },
  });
  await run.completed;
  expect(writers.closed).toHaveBeenCalledTimes(1);
  expect(writers.terminated).not.toHaveBeenCalled();
  expect(run.messages).toEqual([{ id: 1, kind: 'response', ok: true, value: true }]);
  expect(run.finish).toHaveBeenCalledTimes(1);
});

it('joins an early Close to a writer whose startup failed, with no contradicting startup error', async () => {
  const run = startProcess();
  run.receive({ id: 1, op: 'close', payload: null });
  run.writer.emit('message', {
    error: { code: 'open-failed', message: 'The index could not be opened.' },
    kind: 'startup-error',
  });
  await run.completed;
  expect(writers.closed).not.toHaveBeenCalled();
  expect(run.messages).toEqual([{ id: 1, kind: 'response', ok: true, value: true }]);
  expect(run.finish).toHaveBeenCalledTimes(1);
});
