import { afterEach, expect, it, vi } from 'vitest';
import { runIndexerProcess } from '../src/process-core.js';

/** The writer thread, driven by hand: what it was sent, and what it sends and when it exits. */
const writer = vi.hoisted(() => ({
  emit: (_event: 'exit' | 'message', _value: unknown): void => {
    throw new Error('No writer thread');
  },
  posted: [] as unknown[],
  terminate: vi.fn(),
}));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      constructor() {
        super();
        writer.emit = (event, value) => {
          this.emit(event, value);
        };
      }
      postMessage(message: unknown) {
        writer.posted.push(message);
      }
      terminate() {
        writer.terminate();
        return Promise.resolve(0);
      }
    },
  };
});

const exitCode = process.exitCode;
afterEach(() => {
  writer.posted.length = 0;
  writer.terminate.mockClear();
  // A failed Close marks its own process failed; this test's process is not that one.
  process.exitCode = exitCode;
});

/** An indexer whose writer thread has been created and has not answered anything yet. */
function startingIndexer() {
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
  return { completed, finish, messages, receive: (message: unknown) => receive(message) };
}

/** Lets every promise reaction queued so far run. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// BST-2472: terminating a thread inside better-sqlite3's native initialisation aborts the whole
// process, so a writer that is still starting is asked to close like a ready one.
it('asks a starting writer to close and answers the early Close once it has exited', async () => {
  const indexer = startingIndexer();
  indexer.receive({ id: 7, op: 'close', payload: null });
  expect(writer.posted).toEqual([{ id: expect.any(Number), op: 'close', payload: null }]);
  const [asked] = writer.posted as [{ id: number }];

  // The writer finishes starting, takes the request its port held, closes its database and exits.
  writer.emit('message', {
    kind: 'ready',
    value: {
      dbPath: '/tmp/unused-indexer-close.sqlite',
      journalMode: 'wal',
      pid: 1,
      storeId: 'a'.repeat(64),
      writerThreadId: 1,
    },
  });
  writer.emit('message', { id: asked.id, kind: 'response', ok: true, value: true });
  await settled();
  expect(writer.terminate).not.toHaveBeenCalled();
  expect(indexer.messages).toEqual([]);
  expect(indexer.finish).not.toHaveBeenCalled();

  writer.emit('exit', 0);
  await indexer.completed;
  expect(indexer.messages).toEqual([{ id: 7, kind: 'response', ok: true, value: true }]);
  expect(indexer.finish).toHaveBeenCalledTimes(1);
});

it('answers an early Close with the failure of a writer that could not start', async () => {
  const indexer = startingIndexer();
  indexer.receive({ id: 7, op: 'close', payload: null });

  writer.emit('message', {
    error: { code: 'rebuild-required', message: 'The derived index was refused.' },
    kind: 'startup-error',
  });
  writer.emit('exit', 0);
  await indexer.completed;
  // One answer, the Close's own: no second frame reports the same startup again.
  expect(indexer.messages).toEqual([
    expect.objectContaining({ id: 7, kind: 'response', ok: false }),
  ]);
  expect(indexer.finish).toHaveBeenCalledTimes(1);
});
