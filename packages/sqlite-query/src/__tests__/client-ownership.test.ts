import { describe, expect, it, vi } from 'vitest';
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

  // ADR-0031: a failed start waits on no process; its kill is requested and the error thrown.
  it('throws a startup failure at once, with the process killed and its exit not joined', async () => {
    let messageListener: (message: unknown) => void = () => undefined;
    let kills = 0;
    const process: QueryProcess = {
      // Accepted, but the process lingers: its exit never arrives.
      kill: () => {
        kills += 1;
      },
      onError: () => () => undefined,
      onExit: () => () => undefined,
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
    let failure: unknown;
    void SqliteQueryClient.open({
      databasePath: '/recorded/index.sqlite',
      spawn: () => process,
    }).catch((error: unknown) => {
      failure = error;
    });
    await vi.waitFor(() => expect(failure).toMatchObject({ message: 'Index could not open.' }));
    expect(kills).toBe(1);
  });
});
