import type { BackgroundTask, BackgroundTaskManager } from '@mastra/core/background-tasks';
import { describe, expect, it } from 'vitest';
import type { RuntimeData } from '../../types';
import {
  createDelegatedConversationBinding,
  type DelegatedToolActionScope,
} from '../delegated-conversation-binding';
import { createLiveDecisionChannel } from '../live-decision-channel';
import { armLiveDecisions } from '../live-decisions';

/**
 * The remembered-grant answer to a later pause (`suspended`): a pause the
 * function-form gate did not lift (the child reached its gated call before the
 * grant was remembered) is answered by the remembered session grant. No
 * harness row reaches it deterministically — the gate lifts every pause after
 * the grant — so the leg's handler is driven here against the same native
 * snapshot shapes the host reads.
 */
const scope: DelegatedToolActionScope = {
  identity: {
    childRuntimeRunId: 'child-run',
    parentRuntimeRunId: 'root-run',
    parentToolCallId: 'background-child',
    personaId: 'explore',
  },
  resourceId: 'child-resource',
  threadId: 'child-thread',
};

const task = {
  agentId: 'root',
  args: { prompt: 'find the flag' },
  createdAt: new Date(0),
  id: 't1',
  maxRetries: 0,
  resourceId: 'owner',
  retryCount: 0,
  runId: 'root-run',
  status: 'suspended',
  suspendPayload: { requireToolApproval: true },
  threadId: 'root',
  timeoutMs: 1000,
  toolCallId: 'background-child',
  toolName: 'agent-explore',
} as BackgroundTask;

/** "Allow reads this session", remembered by an earlier live decision. */
const readGrant = {
  policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' },
  riskByTool: { 'brainstrike.grepSearch': 'read' },
  sessionGrants: ['read'],
  yolo: false,
} as const;

function harness(options: {
  readonly listTasks?: () => Promise<{ tasks: BackgroundTask[]; total: number }>;
  readonly recordLiveDecision?: (record: unknown) => Promise<void>;
  readonly recordToolActionAnswer?: () => Promise<void>;
}) {
  const records: unknown[] = [];
  const resumed: string[] = [];
  const child = {
    listAgents: async () => ({}),
    listSuspendedRuns: async () => ({
      runs: [
        {
          runId: 'child-run',
          toolCalls: [
            {
              args: { pattern: 'flag' },
              requiresApproval: true,
              toolCallId: 'background-read',
              toolName: 'brainstrike_grepSearch',
            },
          ],
        },
      ],
    }),
  };
  const channel = createLiveDecisionChannel();
  channel.own({
    publish: () => true,
    reserve: () => ({
      release: () => undefined,
      resume: async (resumes) => {
        resumed.push(...resumes.map((entry) => entry.task.id));
      },
    }),
  });
  const runtime = {
    agent: {
      listAgents: async () => ({ explore: child }),
      listSuspendedRuns: async () => ({ runs: [] }),
    },
    askTools: new Map(),
    backgroundTaskManager: {
      listTasks: options.listTasks ?? (async () => ({ tasks: [task], total: 1 })),
      resume: async () => task,
    } as unknown as BackgroundTaskManager,
    conversationBinding: {
      ...createDelegatedConversationBinding(async () => undefined),
      recordLiveDecision:
        options.recordLiveDecision ??
        (async (record: unknown) => {
          records.push(record);
        }),
      recordToolActionAnswer: options.recordToolActionAnswer ?? (async () => undefined),
      resolveParkedInvocation: async (parent: { parentToolCallId: string }) =>
        parent.parentToolCallId === 'background-child' ? scope : undefined,
      resolveToolAction: async () => [scope],
    },
    liveDecisions: channel,
    toolNameMap: new Map([['brainstrike_grepSearch', 'brainstrike.grepSearch']]),
  } as unknown as Parameters<typeof armLiveDecisions>[0];
  armLiveDecisions(runtime, {
    memory: { resourceId: 'owner', threadId: 'root' },
  } as RuntimeData);
  channel.remember(readGrant as never);
  return { channel, records, resumed };
}

describe('armLiveDecisions remembered grant records', () => {
  it('records a pause the remembered grant answered, with the grant it applied', async () => {
    const { channel, records, resumed } = harness({});
    await channel.suspended('t1');
    expect(resumed).toEqual(['t1']);
    // MUTATION: dropping the snapshot from the answered record fails this.
    expect(records).toEqual([
      {
        decision: 'approve',
        delegationToolCallId: 'background-read',
        kind: 'approval',
        outcome: 'remembered-answered',
        policySnapshot: readGrant,
        source: 'remembered-grant',
        taskId: 't1',
        toolCallId: 'background-child',
        toolName: 'brainstrike.grepSearch',
      },
    ]);
  });

  it('records a remembered answer that failed after the parked leaf was known, and resumes nothing', async () => {
    const { channel, records, resumed } = harness({
      recordToolActionAnswer: async () => {
        throw new Error('tool-action-already-consumed-or-root-busy');
      },
    });
    await channel.suspended('t1');
    expect(resumed).toEqual([]);
    expect(records).toEqual([
      {
        delegationToolCallId: 'background-read',
        kind: 'approval',
        outcome: 'remembered-failed',
        reason: 'tool-action-already-consumed-or-root-busy',
        source: 'remembered-grant',
        taskId: 't1',
        toolCallId: 'background-child',
        toolName: 'brainstrike.grepSearch',
      },
    ]);
  });

  it('records no row when the failure comes before the parked leaf is known: no call id is invented', async () => {
    const { channel, records, resumed } = harness({
      listTasks: async () => {
        throw new Error('background store closed');
      },
    });
    await channel.suspended('t1');
    expect(resumed).toEqual([]);
    // MUTATION: recording `toolCallId: taskId` here writes a task id where the
    // dispatch call id belongs.
    expect(records).toEqual([]);
  });

  it('a record the binding rejects surfaces from the handler and never relabels an answered pause as failed', async () => {
    const outcomes: string[] = [];
    const { channel, resumed } = harness({
      recordLiveDecision: async (record) => {
        outcomes.push((record as { outcome: string }).outcome);
        throw new Error('the binding broke its resolve contract');
      },
    });
    await expect(channel.suspended('t1')).rejects.toThrow('the binding broke its resolve contract');
    expect(resumed).toEqual(['t1']);
    // MUTATION: recording inside the attempt lets its catch add a second,
    // `remembered-failed` row for a pause the grant answered.
    expect(outcomes).toEqual(['remembered-answered']);
  });
});
