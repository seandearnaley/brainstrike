// @vitest-environment node
import type { HostRecord } from '@brainstrike/host-lease';
import { expect, it, vi } from 'vitest';
import { createAgentHostPrivateClients } from '../agent-host-private-clients';

vi.mock('electron', () => ({
  MessageChannelMain: class {
    readonly port1 = { side: 1 };
    readonly port2 = { side: 2 };
  },
}));

function child(pid = 4242) {
  const record = { pid, start: `start-${pid}` } as HostRecord;
  const exit = Promise.withResolvers<number>();
  const lost = Promise.withResolvers<void>();
  return {
    exit,
    exited: exit.promise,
    lose: lost.resolve,
    lost: lost.promise,
    postClientPort: vi.fn(),
    record,
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

it('refuses a frame of a launched host that is gone, and never treats it as external', async () => {
  const clients = createAgentHostPrivateClients();
  const launched = child();
  clients.attach(launched);
  expect(clients.open(launched.record)).toBeDefined();

  // Its lifetime channel closed with the process; Electron has not reported the exit yet,
  // and the profile may still hand out its record.
  launched.lose();
  await launched.lost;
  await Promise.resolve();
  expect(() => clients.open(launched.record)).toThrow(
    expect.objectContaining({ failure: expect.objectContaining({ kind: 'refusal' }) })
  );
  expect(launched.postClientPort).toHaveBeenCalledOnce();

  // A host this app did not launch gets no private port.
  expect(clients.open(child(7).record)).toBeUndefined();

  const replacement = child(4343);
  clients.attach(replacement);
  expect(clients.open(replacement.record)).toBeDefined();
  expect(replacement.postClientPort).toHaveBeenCalledOnce();
});
