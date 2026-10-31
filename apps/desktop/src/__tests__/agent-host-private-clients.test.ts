// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createAgentHostPrivateClients } from '../agent-host-private-clients';

vi.mock('electron', () => ({
  MessageChannelMain: class {
    readonly port1 = { side: 1 };
    readonly port2 = { side: 2 };
  },
}));

function child() {
  const exit = Promise.withResolvers<number>();
  const lost = Promise.withResolvers<void>();
  return {
    exit,
    exited: exit.promise,
    lose: lost.resolve,
    lost: lost.promise,
    postClientPort: vi.fn(),
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

it('hands a lost host no client port, even before its exit is reported', async () => {
  const clients = createAgentHostPrivateClients();
  const launched = child();
  clients.attach(launched);
  expect(clients.open()).toBeDefined();

  // Its lifetime channel closed with the process; Electron has not reported the exit yet.
  launched.lose();
  await launched.lost;
  await Promise.resolve();
  expect(clients.open()).toBeUndefined();
  expect(launched.postClientPort).toHaveBeenCalledOnce();

  const replacement = child();
  clients.attach(replacement);
  expect(clients.open()).toBeDefined();
  expect(replacement.postClientPort).toHaveBeenCalledOnce();
});
