import { describe, expect, it } from 'vitest';
import { SqliteQueryClient, SqliteQueryStartupCleanupError } from '../client.js';
import type { QueryProcess } from '../process.js';

describe('startup acquisition ownership', () => {
  it('exposes the retained owner when startup cleanup fails, then permits joined cleanup', async () => {
    let messageListener: (message: unknown) => void = () => undefined;
    let exitListener: () => void = () => undefined;
    let canKill = false;
    const process: QueryProcess = {
      kill: () => {
        if (!canKill) {
          throw new Error('Vendor refused process kill.');
        }
        queueMicrotask(exitListener);
      },
      onError: () => () => undefined,
      onExit: (listener) => {
        exitListener = listener;
        return () => undefined;
      },
      onMessage: (listener) => {
        messageListener = listener;
        return () => undefined;
      },
      postMessage: (request) =>
        queueMicrotask(() =>
          messageListener({
            id: request.id,
            kind: 'error',
            message: 'Index could not open.',
            name: 'Error',
          })
        ),
    };
    const failure = await SqliteQueryClient.open({
      databasePath: '/recorded/index.sqlite',
      deadlineMs: 1000,
      spawn: () => process,
      startupDeadlineMs: 1000,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toHaveProperty('owner');
    expect(failure).toBeInstanceOf(SqliteQueryStartupCleanupError);
    if (!(failure instanceof SqliteQueryStartupCleanupError)) {
      throw new Error('Startup failure did not preserve an accessible owner.');
    }
    expect(failure.errors).toHaveLength(2);
    canKill = true;
    await failure.owner.close();
  });
});
