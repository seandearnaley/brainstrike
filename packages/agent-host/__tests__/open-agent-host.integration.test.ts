import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { HOST_VERSION } from '@brainstrike/host-lease';
import { RootLockedError } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { authenticateHostClient, type HostClient } from '../src/client-connection.js';
import type { HostPlatform } from '../src/ports.js';
import { AGENT_HOST_PROTOCOL_VERSION } from '../src/protocol.js';
import { type OpenedAgentHost, openAgentHost } from '../src/runtime.js';
import { nodePortConnection } from '../src/transports.js';

const roots: string[] = [];
const hosts: OpenedAgentHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const platform = (): HostPlatform => ({
  close: async () => undefined,
  maxSteps: 1,
  readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
  resolveModel: async () => {
    throw new Error('No model in this fixture');
  },
  tools: {},
});
async function open(root: string): Promise<OpenedAgentHost> {
  const host = await openAgentHost(root, platform());
  hosts.push(host);
  return host;
}
/** A client on a port its launcher handed over: it presents no token. */
async function connect(host: OpenedAgentHost): Promise<HostClient> {
  const channel = new MessageChannel();
  host.bindClientConnection(nodePortConnection(channel.port1), 'desktop-ui');
  const closed = Promise.withResolvers<void>();
  channel.port2.once('close', () => closed.resolve());
  return await authenticateHostClient(
    nodePortConnection(channel.port2),
    { hostVersion: HOST_VERSION, protocolVersion: AGENT_HOST_PROTOCOL_VERSION },
    async () => {
      channel.port2.close();
      await closed.promise;
    },
    closed.promise
  );
}

test('a client bound to the host initializes without a token, and its writes survive close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-open-host-'));
  roots.push(root);
  const host = await open(root);
  const client = await connect(host);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  await client.close();
  await host.close();

  const reopened = await open(root);
  const next = await connect(reopened);
  const { rows } = await next.request('thread/read', { fromSeq: 0, threadId });
  expect(rows.map((row) => row.event.type)).toEqual(['command.accepted', 'thread.started']);
  await next.close();
});

test('a second host on the same root is refused while the first is open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-open-host-'));
  roots.push(root);
  await open(root);
  await expect(openAgentHost(root, platform())).rejects.toBeInstanceOf(RootLockedError);
});

test('a refused open closes the platform it was given', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-open-host-'));
  roots.push(root);
  await open(root);
  let closed = false;
  const refused = {
    ...platform(),
    close: async () => {
      closed = true;
    },
  };
  await expect(openAgentHost(root, refused)).rejects.toBeInstanceOf(RootLockedError);
  expect(closed).toBe(true);
});

test('a cancel while Core folds its log rejects the opening and releases the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-open-host-cancel-'));
  roots.push(root);
  const controller = new AbortController();
  const cancelling: HostPlatform = {
    ...platform(),
    // Called during the fold, after the host was composed.
    attachMcpTaskOwner: () => controller.abort(new Error('cancelled during the fold')),
  };
  await expect(openAgentHost(root, cancelling, controller.signal)).rejects.toThrow(
    'cancelled during the fold'
  );
  await open(root);
});
