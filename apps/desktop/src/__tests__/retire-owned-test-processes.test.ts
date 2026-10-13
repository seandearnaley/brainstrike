// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  type OwnedTestProcess,
  retireOwnedTestProcesses,
} from './helpers/retire-owned-test-processes';

const app = { kind: 'app', pid: 211, start: 'app-start' } as const;
const utility = { kind: 'child', pid: 335, start: 'utility-start' } as const;
const command = { kind: 'command', pid: 709, start: 'command-start' } as const;

describe('failed integration process cleanup', () => {
  it('uses SIGTERM for app processes and permits force only for an explicitly owned command', async () => {
    const identities = [app, utility, command];
    const signal = vi.fn();
    const join = vi.fn(async (_owner: OwnedTestProcess) => {});
    await expect(
      retireOwnedTestProcesses(identities, {
        join,
        signal,
        startTime: (pid) => identities.find((owner) => owner.pid === pid)?.start ?? null,
      })
    ).rejects.toBeInstanceOf(AggregateError);
    expect(signal.mock.calls).toEqual([
      [app.pid, 'SIGTERM'],
      [utility.pid, 'SIGTERM'],
      [command.pid, 'SIGKILL'],
    ]);
    expect(join.mock.calls.map(([owner]) => owner)).toEqual(identities);
  });

  it('awaits physical exit and keeps the graceful-cleanup failure after retirement', async () => {
    const exit = Promise.withResolvers<void>();
    const settled = vi.fn();
    const cleanup = retireOwnedTestProcesses([app], {
      join: () => exit.promise,
      signal: vi.fn(),
      startTime: () => app.start,
    });
    void cleanup.then(settled, settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    exit.resolve();
    await expect(cleanup).rejects.toBeInstanceOf(AggregateError);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('retains a failed physical join without escalating the app signal', async () => {
    const failure = new Error('app remained alive');
    const signal = vi.fn();
    const cleanup = retireOwnedTestProcesses([app], {
      join: async () => {
        throw failure;
      },
      signal,
      startTime: () => app.start,
    });
    await expect(cleanup).rejects.toMatchObject({ errors: [expect.any(Error), failure] });
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
