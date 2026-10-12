// @vitest-environment node
/**
 * BST-1932: a host thread view counts the approvals of its delegated children
 * from their own committed logs, through the public client, and answers one in
 * the child's own thread. Only the model is scripted.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentHost,
  attachAgentHost,
  type HostClient,
  hostChildCallSign,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedDelegation } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
} from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { respondToHostApproval } from '../renderer/host-approval-response';
import { HostTreeApprovals } from '../renderer/host-tree-approvals';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** A host whose root delegates once to a Writer child that asks to write (or asks `childCalls`). */
async function delegatingHost(
  writes: unknown[],
  childCalls: readonly { readonly input: unknown; readonly toolId: string }[] = [
    { input: { path: 'notes.md' }, toolId: 'write_file' },
  ]
) {
  const root = await mkdtemp(join(tmpdir(), 'bs-host-tree-approvals-'));
  roots.push(root);
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      delegation: {
        personas: [
          {
            allowedToolIds: ['ask_user', 'write_file'],
            description: 'Writes workspace files.',
            id: 'writer',
            instructions: 'You are the Writer.',
            label: 'Writer',
            maxSteps: 4,
            mode: 'worker',
          },
        ],
        // A child never delegates, so only the root offers the delegation tool.
        settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxDepth: 1 },
      },
      maxSteps: 4,
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask', read: 'allow' },
        yolo: false,
      }),
      resolveModel: async () =>
        scriptedDelegation(
          { input: { prompt: 'Write the notes' }, toolId: 'agent-writer' },
          childCalls
        ),
      tools: {
        ask_user: {
          description: 'Ask the user a question',
          execute: async (_input, context) => context.resumeData,
          identity: 'native-ask-user-generation-1',
          inputSchema: z.object({ question: z.string() }),
          interaction: { kind: 'question', resumeSchema: z.object({ answer: z.string() }) },
          risk: 'read',
        },
        write_file: {
          description: 'Write a workspace file',
          execute: async (input) => {
            writes.push(input);
            return { written: true };
          },
          identity: 'native-write-generation-1',
          inputSchema: z.object({ path: z.string() }),
          risk: 'edit',
        },
      },
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  return client;
}

test('a host thread’s tree shows its child’s approval by call sign until the child’s thread answers it', async () => {
  const writes: unknown[] = [];
  const client = await delegatingHost(writes);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const session = new CommittedThreadSession(client, threadId);
  const tree = new HostTreeApprovals(client, threadId, session);
  const leave = session.connect();
  cleanups.push(async () => {
    await tree.close();
    await leave();
  });
  await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Delegate the notes',
    threadId,
  });

  await expect.poll(() => tree.getSnapshot().length).toBe(1);
  const [child] = (await client.request('thread/children', { threadId })).children;
  if (!child) {
    throw new Error('The root delegated no child');
  }
  const [waiting] = tree.getSnapshot();
  expect(waiting?.owner).toBe(hostChildCallSign(child.threadId));
  expect(waiting?.threadId).toBe(child.threadId);
  expect(waiting?.approval).toMatchObject({
    input: { path: 'notes.md' },
    kind: 'approval',
    risk: 'edit',
    toolId: 'write_file',
  });
  expect(writes).toEqual([]);

  if (!waiting) {
    throw new Error('No approval is waiting');
  }
  await respondToHostApproval(
    client,
    {
      interactionId: waiting.approval.interactionId,
      permissionToolId: waiting.approval.toolCatalogId ?? waiting.approval.toolId,
      risk: waiting.approval.risk,
      runId: waiting.approval.runId,
      threadId: waiting.threadId,
    },
    { approved: true }
  );
  await expect.poll(() => tree.getSnapshot()).toEqual([]);
  await expect.poll(() => writes).toEqual([{ path: 'notes.md' }]);
  // AT-07: the answered approval stays in the tree's history, owner-named, with its decision.
  expect(tree.getAnswered()).toMatchObject([
    {
      approval: { input: { path: 'notes.md' }, interactionId: waiting.approval.interactionId },
      decision: 'approve',
      owner: hostChildCallSign(child.threadId),
      threadId: child.threadId,
    },
  ]);
});

test('a host thread’s tree names its child’s pending question until the child’s thread answers it', async () => {
  const client = await delegatingHost(
    [],
    [{ input: { question: 'Which root?' }, toolId: 'ask_user' }]
  );
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const session = new CommittedThreadSession(client, threadId);
  const tree = new HostTreeApprovals(client, threadId, session);
  const leave = session.connect();
  cleanups.push(async () => {
    await tree.close();
    await leave();
  });
  await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Delegate the notes',
    threadId,
  });

  await expect.poll(() => tree.getInteractions().length).toBe(1);
  const [child] = (await client.request('thread/children', { threadId })).children;
  if (!child) {
    throw new Error('The root delegated no child');
  }
  const [waiting] = tree.getInteractions();
  expect(waiting).toMatchObject({
    interaction: { input: { question: 'Which root?' }, kind: 'question' },
    owner: hostChildCallSign(child.threadId),
    threadId: child.threadId,
  });
  // A question is not an approval: the approvals strip does not count it.
  expect(tree.getSnapshot()).toEqual([]);

  await client.request('interaction/resume', {
    commandId: randomUUID(),
    interactionId: waiting?.interaction.interactionId ?? '',
    resumeData: { answer: 'Local' },
    runId: waiting?.interaction.runId ?? '',
    threadId: child.threadId,
  });
  await expect.poll(() => tree.getInteractions().length).toBe(0);
});
