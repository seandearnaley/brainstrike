// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { createAgentHostPrivateClients } from '../agent-host-private-clients';

function child() {
  const exit = Promise.withResolvers<number>();
  return {
    exit,
    exited: exit.promise,
    openClientPort: vi.fn(),
    stopForRelaunch: vi.fn(() => exit.promise),
  };
}

it('stops only the live host this app launched, and nothing once it has exited', async () => {
  const clients = createAgentHostPrivateClients();
  // A CLI `host start` hands out no child: a restart has nothing to stop.
  expect(clients.stopForRelaunch()).toBeUndefined();

  const launched = child();
  clients.attach(launched);
  const stopping = clients.stopForRelaunch();
  expect(launched.stopForRelaunch).toHaveBeenCalledOnce();
  launched.exit.resolve(0);
  await expect(stopping).resolves.toBe(0);
  await launched.exited;
  await Promise.resolve();

  expect(clients.stopForRelaunch()).toBeUndefined();
  expect(launched.stopForRelaunch).toHaveBeenCalledOnce();
});
