// @vitest-environment node
import type { HostClient } from '@brainstrike/agent-host/browser';
import type { HostResults } from '@brainstrike/agent-host/protocol';
import { refusalError } from '@brainstrike/assistant-contract';
import { expect, test, vi } from 'vitest';
import { HostTreeApprovals } from '../renderer/host-tree-approvals';

type Tree = HostResults['thread/tree'];

const origin = {
  background: true,
  depth: 1,
  parentRunId: 'root-run',
  parentThreadId: 'root',
  persona: 'explore',
  toolCallId: 'call-1',
  turnId: 'root-run',
} as unknown as Tree['descendants'][number]['origin'];

function child(fields: Partial<Tree['descendants'][number]>): Tree['descendants'][number] {
  return {
    answered: [],
    callSign: 'Explorer 1',
    color: 'emerald',
    origin,
    pending: [],
    run: {
      delegatedInvocation: true,
      modelId: 'openrouter::anthropic/claude-opus-5.5',
      status: 'running',
      toolCalls: 2,
      turnId: 'root-run',
    },
    threadId: 'child',
    ...fields,
  };
}

/** A client whose `thread/tree` answers come from `answer`, told of tree changes by `change`. */
function treeClient(answer: () => Promise<Tree>) {
  let changed: ((threadIds: readonly string[]) => void) | undefined;
  const closed = Promise.withResolvers<void>();
  const client = {
    closed: closed.promise,
    onTreeChanged: (listener: (threadIds: readonly string[]) => void) => {
      changed = listener;
      return () => undefined;
    },
    request: vi.fn(async () => answer()),
  } as unknown as HostClient;
  return {
    change: (threadIds: readonly string[]) => changed?.(threadIds),
    client,
    lose: () => closed.resolve(),
  };
}

const tree = (descendants: Tree['descendants']): Tree => ({
  descendants,
  thread: { answered: [], pending: [], run: null, threadId: 'root' },
});

test('a delegated thread whose history cannot be read shows why on its card', async () => {
  const { client } = treeClient(async () =>
    tree([child({ damage: 'Expected "observation" | "reflection"', run: null })])
  );
  const approvals = new HostTreeApprovals(client, 'root');
  await expect
    .poll(() => approvals.read('child'))
    .toEqual({
      reason: 'This thread\'s history cannot be read: Expected "observation" | "reflection"',
      status: 'unavailable',
      toolCalls: 0,
    });
  approvals.close();
});

test('a tree the host cannot serve makes every card unavailable, with the reason, until it can', async () => {
  let answer: () => Promise<Tree> = async () => tree([child({})]);
  const { change, client } = treeClient(() => answer());
  const approvals = new HostTreeApprovals(client, 'root');
  await expect
    .poll(() => approvals.read('child'))
    .toEqual({
      // The card names the model the child runs on, from Core's summary (ADR-0037).
      modelId: 'openrouter::anthropic/claude-opus-5.5',
      status: 'running',
      toolCalls: 2,
    });

  answer = async () => {
    throw refusalError('input', 'thread.unknown', 'Unknown thread');
  };
  change(['child', 'root']);
  await expect.poll(() => approvals.read('child')?.status).toBe('unavailable');
  expect(approvals.read('another-child')).toMatchObject({ status: 'unavailable' });

  answer = async () =>
    tree([
      child({
        run: {
          delegatedInvocation: true,
          modelId: 'openrouter::anthropic/claude-opus-5.5',
          status: 'completed',
          toolCalls: 3,
          turnId: 'root-run',
        },
      }),
    ]);
  change(['child', 'root']);
  await expect
    .poll(() => approvals.read('child'))
    .toEqual({
      modelId: 'openrouter::anthropic/claude-opus-5.5',
      status: 'completed',
      toolCalls: 3,
    });
  approvals.close();
});

test("a child's network consent waits at the root to be answered in the child, never in the approval strip", async () => {
  const pending = (interactionId: string, kind: 'approval' | 'network') =>
    ({
      input: {},
      interactionId,
      kind,
      runId: 'child-run',
      toolCallId: `${interactionId}-call`,
      toolId: 'run_python',
      toolIdentity: 'identity-1',
      type: 'interaction.requested',
    }) as Tree['descendants'][number]['pending'][number];
  const { client } = treeClient(async () =>
    tree([child({ pending: [pending('approve-1', 'approval'), pending('network-1', 'network')] })])
  );
  const approvals = new HostTreeApprovals(client, 'root');
  await expect
    .poll(() => approvals.getInteractions().map(({ interaction }) => interaction.interactionId))
    .toEqual(['network-1']);
  expect(approvals.getSnapshot().map(({ approval }) => approval.interactionId)).toEqual([
    'approve-1',
  ]);
  approvals.close();
});

test('a lost host leaves no subagent shown as working, and no turn to stop', async () => {
  const { client, lose } = treeClient(async () => ({
    ...tree([child({ origin: { ...origin, background: true } })]),
    thread: {
      answered: [],
      pending: [],
      run: {
        delegatedInvocation: true,
        modelId: 'openai::gpt-6-sol',
        status: 'running',
        toolCalls: 0,
        turnId: 'root-run',
      },
      threadId: 'root',
    },
  }));
  const approvals = new HostTreeApprovals(client, 'root');
  await expect.poll(() => approvals.getRunning().children.length).toBe(1);
  expect(approvals.getRunning().activeTurnId).toBe('root-run');

  lose();
  await expect.poll(() => approvals.read('child')?.status).toBe('unavailable');
  expect(approvals.getRunning()).toEqual({ children: [] });
  approvals.close();
});
