// @vitest-environment node
import { CHILD_CLOSE_BUDGET_MS, CHILD_SIGNAL_GRACE_MS } from '@brainstrike/state-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type OwnedTestProcess,
  retireOwnedTestProcesses,
} from './helpers/retire-owned-test-processes';

const app = { kind: 'app', pid: 211, start: 'app-start' } as const;
const utility = { kind: 'child', pid: 335, start: 'utility-start' } as const;
const command = { kind: 'command', pid: 709, start: 'command-start' } as const;
const GUARANTEE_MS = CHILD_CLOSE_BUDGET_MS + CHILD_SIGNAL_GRACE_MS;

/** Processes that exit only when signalled. */
function signalledExits(identities: readonly OwnedTestProcess[]) {
  const exits = new Map(identities.map((owner) => [owner.pid, Promise.withResolvers<void>()]));
  return {
    join: vi.fn((owner: OwnedTestProcess) => exits.get(owner.pid)?.promise ?? Promise.resolve()),
    signal: vi.fn((pid: number) => exits.get(pid)?.resolve()),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('owned integration process cleanup', () => {
  it('leaves alone a process that exits within its owner close guarantee', async () => {
    const exit = Promise.withResolvers<void>();
    const signal = vi.fn();
    const cleanup = retireOwnedTestProcesses([app], {
      join: () => exit.promise,
      signal,
      startTime: () => app.start,
    });
    await vi.advanceTimersByTimeAsync(GUARANTEE_MS - 1);
    exit.resolve();
    await expect(cleanup).resolves.toBeUndefined();
    expect(signal).not.toHaveBeenCalled();
  });

  it('uses SIGTERM for app processes and permits force only for an explicitly owned command', async () => {
    const identities = [app, utility, command];
    const { join, signal } = signalledExits(identities);
    const cleanup = retireOwnedTestProcesses(identities, {
      join,
      signal,
      startTime: (pid) => identities.find((owner) => owner.pid === pid)?.start ?? null,
    });
    const failure = expect(cleanup).rejects.toBeInstanceOf(AggregateError);
    await vi.advanceTimersByTimeAsync(GUARANTEE_MS);
    await failure;
    expect(signal.mock.calls).toEqual([
      [app.pid, 'SIGTERM'],
      [utility.pid, 'SIGTERM'],
      [command.pid, 'SIGKILL'],
    ]);
  });

  it('joins the exit after the signal, and the process left behind stays a failure', async () => {
    const exit = Promise.withResolvers<void>();
    const settled = vi.fn();
    const cleanup = retireOwnedTestProcesses([app], {
      join: () => exit.promise,
      signal: vi.fn(),
      startTime: () => app.start,
    });
    void cleanup.then(settled, settled);
    await vi.advanceTimersByTimeAsync(GUARANTEE_MS);
    expect(settled).not.toHaveBeenCalled();
    exit.resolve();
    await expect(cleanup).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: 'Owned app or Root process outlived its owner: app 211',
        }),
      ],
    });
  });

  it('keeps a failed physical join without escalating the app signal', async () => {
    const failure = new Error('app remained alive');
    const signal = vi.fn();
    let joins = 0;
    const cleanup = retireOwnedTestProcesses([app], {
      join: () => {
        joins += 1;
        return joins === 1 ? new Promise<void>(() => undefined) : Promise.reject(failure);
      },
      signal,
      startTime: () => app.start,
    });
    const rejected = expect(cleanup).rejects.toMatchObject({
      errors: [expect.any(Error), failure],
    });
    await vi.advanceTimersByTimeAsync(GUARANTEE_MS);
    await rejected;
    expect(signal.mock.calls).toEqual([[app.pid, 'SIGTERM']]);
  });

  it('does not signal or join an exited or reused identity', async () => {
    const signal = vi.fn();
    const join = vi.fn();
    await retireOwnedTestProcesses([app], { join, signal, startTime: () => 'new-start' });
    expect(signal).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });
});
