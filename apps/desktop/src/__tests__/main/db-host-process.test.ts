import { EventEmitter } from 'node:events';
import type { UtilityProcess } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbHostProcess } from '../../db-host-process';

describe('DbHostProcess construction', () => {
  const unhandledRejections: unknown[] = [];
  const recordRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };

  beforeEach(() => {
    unhandledRejections.length = 0;
    process.on('unhandledRejection', recordRejection);
  });

  afterEach(() => {
    process.off('unhandledRejection', recordRejection);
  });

  // A failed fork (or a broken handle) must fail the caller at once. The exit listener used to be
  // registered inside the `exited` promise executor, so the TypeError rejected a promise nothing
  // awaits: the fork failure was invisible to the caller and surfaced as an unhandled rejection.
  it.each([
    { handle: undefined, name: 'a fork that returned nothing' },
    {
      handle: {
        once: () => {
          throw new Error('once failed');
        },
      },
      name: 'a handle whose once() throws',
    },
  ])('throws synchronously for $name, leaving no rejected promise behind', async ({ handle }) => {
    expect(() => new DbHostProcess(handle as unknown as UtilityProcess)).toThrow();

    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandledRejections).toEqual([]);
  });

  it('registers its exit listener at construction, so an exit before anyone waits is not missed', async () => {
    const handle = new EventEmitter();
    const hostProcess = new DbHostProcess(handle as unknown as UtilityProcess);

    handle.emit('exit', 9);

    await expect(hostProcess.exited).resolves.toBe(9);
    expect(hostProcess.exitCode).toBe(9);
  });
});
