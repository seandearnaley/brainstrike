// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restartLaunchedAgentHost } from '../agent-host-restart';

// BST-1880: the damaged-store notice restarts only the host this app launched.

const record = { pid: 4242 } as never;
const logger = { info: vi.fn() };
const attachment = () => ({ close: vi.fn(), closed: new Promise<void>(() => undefined), record });

afterEach(() => {
  vi.useRealTimers();
});

describe('restartLaunchedAgentHost', () => {
  it('refuses a host this app did not launch, and stops nothing', async () => {
    const acquireProfile = vi.fn();

    await expect(
      restartLaunchedAgentHost({ acquireProfile, logger, stopLaunchedHost: () => undefined })
    ).rejects.toMatchObject({
      failure: { code: 'agent-host.restart.external', kind: 'refusal' },
    });
    expect(acquireProfile).not.toHaveBeenCalled();
  });

  it('stops the launched host through its lease and relaunches only once its exit is joined', async () => {
    const exit = Promise.withResolvers<number>();
    const stopLaunchedHost = vi.fn(() => exit.promise);
    const acquireProfile = vi.fn(async () => attachment());
    let resolved = false;

    const restart = restartLaunchedAgentHost({ acquireProfile, logger, stopLaunchedHost }).then(
      () => {
        resolved = true;
      }
    );
    await Promise.resolve();
    expect(stopLaunchedHost).toHaveBeenCalledOnce();
    expect(acquireProfile).not.toHaveBeenCalled();
    expect(resolved).toBe(false);

    exit.resolve(0);
    await restart;
    expect(resolved).toBe(true);
    // Relaunched here, after the exit: the profile acquisition admits the next host.
    expect(acquireProfile).toHaveBeenCalledOnce();
  });

  it('joins a stopped host that takes 12 s to exit and relaunches it, never refusing the restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const exit = Promise.withResolvers<number>();
    setTimeout(() => exit.resolve(0), 12_000);
    const acquireProfile = vi.fn(async () => attachment());
    let outcome: unknown = 'pending';
    const restart = restartLaunchedAgentHost({
      acquireProfile,
      logger,
      stopLaunchedHost: () => exit.promise,
    }).then(
      () => {
        outcome = 'restarted';
      },
      (error: unknown) => {
        outcome = error;
      }
    );
    await vi.advanceTimersByTimeAsync(11_999);
    const beforeExit = outcome;
    await vi.advanceTimersByTimeAsync(1);
    await restart;

    expect({ beforeExit, outcome }).toEqual({ beforeExit: 'pending', outcome: 'restarted' });
    expect(acquireProfile).toHaveBeenCalledOnce();
  });

  it('reports a failed relaunch as its own failure', async () => {
    const failure = new Error('relaunch failed');

    await expect(
      restartLaunchedAgentHost({
        acquireProfile: () => Promise.reject(failure),
        logger,
        stopLaunchedHost: () => Promise.resolve(0),
      })
    ).rejects.toBe(failure);
  });
});
