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
import { hostChildCallSign } from '@brainstrike/agent-host';
import {
  type InProcessHost,
  openInProcessHost,
} from '@brainstrike/agent-host/test-fixtures/in-process-host';
import { scriptedDelegation } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
} from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { respondToHostApproval } from '../renderer/host-approval-response';
import { HostTreeApprovals } from '../renderer/host-tree-approvals';

const roots: string[] = [];
const hosts: InProcessHost[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
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
  const host = await openInProcessHost(root, {
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
  });
  hosts.push(host);
  return await host.connect();
}

test('the committed child approval already counts its call while the stream consumer is held', async () => {
  const client = await delegatingHost([]);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const session = new CommittedThreadSession(client, threadId);
  const tree = new HostTreeApprovals(client, threadId, session);
  const leave = session.connect();
  const release = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const approval = Promise.withResolvers<void>();
  const unsubscribe = tree.subscribe(() => {
    if (tree.getSnapshot().length > 0) {
      approval.resolve();
    }
  });
  const append = StateStore.prototype.append;
  const store = vi.spyOn(StateStore.prototype, 'append').mockImplementation(async function (
    this: StateStore,
    items,
    ...options
  ) {
    if (
      items.some(({ event }) => {
        const chunk = event['chunk'];
        return (
          event.type === 'stream.chunk' &&
          chunk !== null &&
          typeof chunk === 'object' &&
          'type' in chunk &&
          chunk.type === 'tool-call' &&
          'toolName' in chunk &&
          chunk.toolName === 'write_file'
        );
      })
    ) {
      held.resolve();
      await release.promise;
    }
    return append.call(this, items, ...options);
  });
  try {
    await client.request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Delegate the notes',
      threadId,
    });
    await Promise.all([held.promise, approval.promise]);
    const waiting = tree.getSnapshot()[0];
    expect(waiting).toBeDefined();
    if (!waiting) {
      throw new Error('No child approval');
    }
    // Both arrive on the child's one ordered log. Its model.step and approval
    // committed together while the separate stream.chunk has not committed.
    const { rows } = await client.request('thread/read', {
      fromSeq: 0,
      threadId: waiting.threadId,
    });
    expect(rows.some(({ event }) => event.type === 'model.step')).toBe(true);
    expect(tree.read(waiting.threadId)).toEqual({ status: 'needs-input', toolCalls: 1 });
    release.resolve();
    // The later stream copy must not count the same tool call twice.
    await client.request('run/stop', {
      commandId: randomUUID(),
      runId: waiting.approval.runId,
      threadId: waiting.threadId,
    });
    expect(tree.read(waiting.threadId)?.toolCalls).toBe(1);
  } finally {
    release.resolve();
    store.mockRestore();
    unsubscribe();
    await tree.close();
    await leave();
  }
});

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
  // The child's own log says it waits on a person, one tool call in.
  expect(tree.read(child.threadId)).toEqual({ status: 'needs-input', toolCalls: 1 });

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
  await expect.poll(() => tree.read(child.threadId)).toEqual({ status: 'completed', toolCalls: 1 });
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
