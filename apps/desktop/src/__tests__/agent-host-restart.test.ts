// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const { attachAgentHost } = vi.hoisted(() => ({ attachAgentHost: vi.fn() }));
vi.mock('@brainstrike/agent-host/client', () => ({ attachAgentHost }));

import { restartLaunchedAgentHost } from '../agent-host-restart';

// BST-1880: the damaged-store notice restarts only the host this app launched.

const record = { pid: 4242 } as never;
const logger = { info: vi.fn() };

function hostClient() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    request: vi.fn().mockResolvedValue({ outcome: 'stopped', rootReleased: true }),
  };
}

describe('restartLaunchedAgentHost', () => {
  it('refuses a host this app did not launch, and stops nothing', async () => {
    const acquireProfile = vi.fn();

    await expect(
      restartLaunchedAgentHost({ acquireProfile, exited: () => undefined, logger })
    ).rejects.toMatchObject({
      failure: { code: 'agent-host.restart.external', kind: 'refusal' },
    });
    expect(acquireProfile).not.toHaveBeenCalled();
    expect(attachAgentHost).not.toHaveBeenCalled();
  });

  it('stops the launched host over its socket and resolves only once it has exited', async () => {
    const client = hostClient();
    attachAgentHost.mockResolvedValueOnce(client);
    const exit = Promise.withResolvers<number>();
    let resolved = false;
    const acquireProfile = vi.fn(async () => ({
      close: vi.fn(),
      closed: new Promise<void>(() => undefined),
      record,
    }));

    const restart = restartLaunchedAgentHost({
      acquireProfile,
      exited: () => exit.promise,
      logger,
    }).then(() => {
      resolved = true;
    });
    await vi.waitFor(() => {
      expect(client.request).toHaveBeenCalledWith('host/stop', {});
    });
    expect(attachAgentHost).toHaveBeenCalledWith(record);
    expect(client.close).toHaveBeenCalled();
    await Promise.resolve();
    expect(resolved).toBe(false);

    exit.resolve(0);
    await restart;
    expect(resolved).toBe(true);
    // Relaunched here, after the exit: the stop's own acquisition, then the relaunch.
    expect(acquireProfile).toHaveBeenCalledTimes(2);
  });

  it('says so when the stopped host never exits', async () => {
    attachAgentHost.mockResolvedValueOnce(hostClient());

    await expect(
      restartLaunchedAgentHost({
        acquireProfile: async () => ({
          close: vi.fn(),
          closed: new Promise(() => undefined),
          record,
        }),
        exited: () => new Promise(() => undefined),
        exitTimeoutMs: 20,
        logger,
      })
    ).rejects.toThrow('The agent host stopped but did not exit.');
  });
});
