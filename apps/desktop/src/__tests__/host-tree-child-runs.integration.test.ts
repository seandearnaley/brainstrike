// @vitest-environment node
/**
 * Live QA 2026-10-16: a host thread view follows each delegated child's run
 * from the child's own committed log — working with its tool calls while it
 * runs, then how it ended — and, between the parent's runs, stops the turn of
 * its still-working background children through the host's `run/stop`. Only
 * the model is scripted.
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
import {
  scriptedDelegation,
  scriptedHeldDelegation,
} from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
} from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { HostTreeApprovals, stopHostChildTurns } from '../renderer/host-tree-approvals';

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

const DELEGATE = { input: { prompt: 'Survey the notes' }, toolId: 'agent-explore' };
const READS = [
  { input: { path: 'a.md' }, toolId: 'read_note' },
  { input: { path: 'b.md' }, toolId: 'read_note' },
  { input: { path: 'c.md' }, toolId: 'read_note' },
];

/** A host whose root delegates once, in the background, to an Explorer that reads notes. */
async function explorerHost(model: ReturnType<typeof scriptedDelegation>) {
  const root = await mkdtemp(join(tmpdir(), 'bs-host-tree-child-runs-'));
  roots.push(root);
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      delegation: {
        personas: [
          {
            allowedToolIds: ['read_note'],
            description: 'Reads workspace notes.',
            id: 'explore',
            instructions: 'You are the Explorer.',
            label: 'Explorer',
            maxSteps: 8,
            mode: 'read-only',
          },
        ],
        settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxDepth: 1 },
      },
      maxSteps: 8,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveModel: async () => model,
      tools: {
        read_note: {
          description: 'Read a workspace note',
          execute: async (input) => ({ read: input }),
          identity: 'native-read-note-generation-1',
          inputSchema: z.object({ path: z.string() }),
          risk: 'read',
        },
      },
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const session = new CommittedThreadSession(client, threadId);
  const tree = new HostTreeApprovals(client, threadId, session);
  const leave = session.connect();
  cleanups.push(async () => {
    await tree.close();
    await leave();
  });
  return { client, session, threadId, tree };
}

const runStarts = (session: CommittedThreadSession) =>
  session.getSnapshot().rows.filter(({ event }) => event.type === 'run.started');
const finished = (session: CommittedThreadSession) =>
  session.getSnapshot().rows.some(({ event }) => event.type === 'run.finished');

test('a host thread’s tree reads its child’s run and tool calls from the child’s own log', async () => {
  const { client, threadId, tree } = await explorerHost(scriptedDelegation(DELEGATE, READS));
  await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Delegate the survey',
    threadId,
  });
  await expect
    .poll(async () => (await client.request('thread/children', { threadId })).children.length)
    .toBe(1);
  const [child] = (await client.request('thread/children', { threadId })).children;
  if (!child) {
    throw new Error('The root delegated no child');
  }
  // The background child's own log is the truth: its three calls, then its end.
  await expect.poll(() => tree.read(child.threadId)).toEqual({ status: 'completed', toolCalls: 3 });
  // The read keeps its identity until the child's run changes.
  expect(tree.read(child.threadId)).toBe(tree.read(child.threadId));
  await expect.poll(() => tree.getRunning().children).toEqual([]);
});

test('between the parent’s runs, the tree names its working background child and Stop ends it without a wake', async () => {
  const { client, session, threadId, tree } = await explorerHost(
    scriptedHeldDelegation(DELEGATE, READS.slice(0, 2))
  );
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Delegate the survey',
    threadId,
  });
  await expect
    .poll(async () => (await client.request('thread/children', { threadId })).children.length)
    .toBe(1);
  const [child] = (await client.request('thread/children', { threadId })).children;
  if (!child) {
    throw new Error('The root delegated no child');
  }
  // The parent answered and ended; its child still works, two calls in.
  await expect.poll(() => finished(session)).toBe(true);
  await expect.poll(() => tree.read(child.threadId)).toEqual({ status: 'running', toolCalls: 2 });
  await expect
    .poll(() => tree.getRunning())
    .toEqual({
      children: [
        { owner: hostChildCallSign(child.threadId), threadId: child.threadId, turnId: runId },
      ],
      idle: true,
    });

  await stopHostChildTurns(client, threadId, tree.getRunning());
  await expect.poll(() => tree.read(child.threadId)).toEqual({ status: 'stopped', toolCalls: 2 });
  await expect.poll(() => tree.getRunning().children).toEqual([]);
  // A stopped turn's results wait for the next user turn: a wake would have
  // been admitted ahead of it in the host's one admission queue.
  const next = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Why did it stop?',
    threadId,
  });
  await expect.poll(() => runStarts(session).length).toBe(2);
  expect(
    runStarts(session).map(({ event }) =>
      event.type === 'run.started' ? [event.runId, event.delivery?.via] : []
    )
  ).toEqual([
    [runId, undefined],
    [next.runId, 'next-turn'],
  ]);
});
