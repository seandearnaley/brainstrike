// @vitest-environment node
/**
 * A host thread shows the model's text live from uncommitted telemetry, and a
 * user's Stop mid-step keeps the partial reply across a reload, as legacy did
 * (ADR-0011 amendment). Only the model is scripted.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentHost,
  attachAgentHost,
  type HostClient,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedPartialThenHeld } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import {
  type CommittedHostConversation,
  createCommittedHostConversation,
} from '../renderer/committed-host-conversation';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const PARTIAL = 'PARTIAL_REPLY_4417 ';

function answerTexts(view: CommittedHostConversation): string[] {
  return view.store
    .getSnapshot()
    .repository.messages.flatMap(({ message }) =>
      message.role === 'assistant'
        ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
        : []
    );
}

test('a host thread shows text live, and a Stop keeps the partial reply across a reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-host-live-text-'));
  roots.push(root);
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => scriptedPartialThenHeld(PARTIAL),
      tools: {},
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const open = (): CommittedHostConversation => {
    const view = createCommittedHostConversation({ client, modelId: 'scripted', threadId });
    cleanups.push(async () => {
      view.close();
      // close() sends `log/unsubscribe` without awaiting it; this round-trip joins it.
      await client.request('thread/list', {});
    });
    return view;
  };
  const view = open();
  await expect.poll(() => view.store.getSnapshot().isLoading).toBe(false);

  await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Answer slowly',
    threadId,
  });
  // Live, from telemetry: nothing about this text is committed yet.
  await expect.poll(() => answerTexts(view)).toEqual([PARTIAL]);

  await view.commands.onCancel?.();
  await expect.poll(() => view.store.getSnapshot().isRunning).toBe(false);
  expect(answerTexts(view)).toEqual([PARTIAL]);

  const reloaded = open();
  await expect.poll(() => reloaded.store.getSnapshot().isLoading).toBe(false);
  expect(answerTexts(reloaded)).toEqual([PARTIAL]);
});
