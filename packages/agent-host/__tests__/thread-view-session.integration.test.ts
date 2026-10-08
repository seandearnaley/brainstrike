/**
 * CommittedThreadSession's disconnect against a real host (BST-1929, #3543
 * 6054686006).
 *
 * vscode-jsonrpc's `sendRequest` rethrows a failed write from an async
 * promise executor, so a request whose write is still queued when its client
 * closes surfaces as an unhandled rejection no caller can observe. The CLI
 * session already joins its `log/unsubscribe` and skips it once the
 * connection has closed (cli-session.ts); the renderer session must do the
 * same, and must never swallow a real unsubscribe failure.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { CommittedThreadSession } from '../src/thread-view.js';
import { scriptedModel } from './fixtures/scripted-model.js';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** A subscribed session on a real host, with every request it sends recorded. */
async function subscribedSession(refuse?: string) {
  const root = await mkdtemp(join(tmpdir(), 'bs-thread-view-session-'));
  roots.push(root);
  const model = scriptedModel();
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => model,
      tools: {},
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const requests: string[] = [];
  const recorded: HostClient = {
    ...client,
    request: (method, params) => {
      requests.push(method);
      return method === refuse
        ? Promise.reject(new Error(`${method} refused by the test host`))
        : client.request(method, params);
    },
  };
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const session = new CommittedThreadSession(recorded, threadId);
  const disconnect = session.connect();
  // One round-trip on the same connection: the subscribe is written and answered.
  await client.request('thread/list', {});
  return { client, disconnect, requests };
}

/** Unhandled rejections raised while `act` runs and the following event-loop turns. */
async function unhandledDuring(act: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const record = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', record);
  try {
    await act();
    for (let turn = 0; turn < 5; turn += 1) {
      await nextTurn();
    }
  } finally {
    process.off('unhandledRejection', record);
  }
  return unhandled;
}

test('the disposer joins its unsubscribe, so an owner closing the client next leaves no unhandled rejection', async () => {
  const { client, disconnect, requests } = await subscribedSession();
  const unhandled = await unhandledDuring(async () => {
    await disconnect();
    await client.close();
  });
  expect(unhandled).toEqual([]);
  expect(requests).toEqual(['log/subscribe', 'log/unsubscribe']);
});

test('a closed connection already ended the subscription: the disposer sends nothing and settles', async () => {
  const { client, disconnect, requests } = await subscribedSession();
  await client.close();
  await expect(disconnect()).resolves.toBeUndefined();
  expect(requests).toEqual(['log/subscribe']);
});

test('an unsubscribe the open host refuses rejects the disposer instead of being swallowed', async () => {
  const { disconnect } = await subscribedSession('log/unsubscribe');
  await expect(disconnect()).rejects.toThrow('log/unsubscribe refused by the test host');
});
