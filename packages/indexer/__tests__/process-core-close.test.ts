import { expect, it, vi } from 'vitest';
import { runIndexerProcess } from '../src/process-core.js';

const calls = vi.hoisted(() => ({
  exit: Promise.withResolvers<void>(),
  exited: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      private exited = false;
      postMessage() {}
      terminate() {
        calls.terminate();
        return calls.exit.promise.then(() => {
          if (!this.exited) {
            this.exited = true;
            calls.exited();
            this.emit('exit', 0);
          }
          return 0;
        });
      }
    },
  };
});

it('joins an early Close and does not contradict its response with a startup error', async () => {
  const messages: object[] = [];
  const finish = vi.fn();
  let receive: (message: unknown) => void = () => {
    throw new Error('No message listener');
  };
  const completed = runIndexerProcess(
    {
      dbPath: '/tmp/unused-indexer-close.sqlite',
      embedding: { indexMode: 'text-only' },
      rootIds: ['root-a'],
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
  receive({ id: 1, op: 'close', payload: null });
  expect(calls.terminate).toHaveBeenCalledTimes(1);
  expect(messages).toEqual([]);
  expect(finish).not.toHaveBeenCalled();
  calls.exit.resolve();
  await completed;
  expect(calls.exited).toHaveBeenCalledTimes(1);
  expect(messages).toEqual([{ id: 1, kind: 'response', ok: true, value: true }]);
  expect(finish).toHaveBeenCalledTimes(1);
});
