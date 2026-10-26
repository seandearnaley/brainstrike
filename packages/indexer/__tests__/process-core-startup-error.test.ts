import { expect, it, vi } from 'vitest';
import { runIndexerProcess } from '../src/process-core.js';

const calls = vi.hoisted(() => ({
  exit: Promise.withResolvers<void>(),
  worker: undefined as undefined | { emit(event: string, value: unknown): boolean },
}));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      constructor() {
        super();
        calls.worker = this;
      }
      postMessage() {}
      terminate() {
        return calls.exit.promise.then(() => {
          this.emit('exit', 1);
          return 1;
        });
      }
    },
  };
});

// ADR-0031: a failed startup is reported at once, while its writer thread is still being torn down.
it('reports a failed startup before its writer thread has terminated', async () => {
  const messages: object[] = [];
  const finish = vi.fn();
  const completed = runIndexerProcess(
    {
      dbPath: '/tmp/unused-indexer-startup-error.sqlite',
      embedding: { indexMode: 'text-only' },
      rootIds: ['root-a'],
    },
    { finish, onMessage: () => {}, send: (message) => messages.push(message) }
  );
  calls.worker?.emit('message', {
    error: { code: 'open-failed', message: 'Store did not open.' },
    kind: 'startup-error',
  });
  await vi.waitFor(() =>
    expect(messages).toEqual([
      { error: expect.objectContaining({ code: 'open-failed' }), kind: 'startup-error' },
    ])
  );
  expect(finish).not.toHaveBeenCalled();

  calls.exit.resolve();
  await completed;
  expect(finish).toHaveBeenCalledTimes(1);
});
