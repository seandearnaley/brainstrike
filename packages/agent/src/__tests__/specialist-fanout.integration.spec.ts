import {
  buildNativeToolRiskMap,
  getToolActionTarget,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract';
import { BUILT_IN_PERSONAS } from '@brainstrike/assistant-contract/personas';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createDelegatedConversationBinding,
  type DelegatedConversationIdentity,
  type DelegatedToolActionScope,
} from '../mastra/delegated-conversation-binding';
import type { DelegatedRunIdentity } from '../mastra/delegated-run-publication';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../test-fixtures/scripted-agent-model';
import type { StreamChunk } from '../types';

const { modelHolder } = vi.hoisted(() => ({
  modelHolder: { current: undefined as ReturnType<typeof scriptedAgentModel>['model'] | undefined },
}));
vi.mock('../providers/provider-factory', async (original) => ({
  ...(await original<typeof import('../providers/provider-factory')>()),
  createProvider: () => {
    if (!modelHolder.current) {
      throw new Error('Missing scripted model');
    }
    return modelHolder.current;
  },
}));
const { streamMastraAgent, streamMastraToolApprovalAction } = await import(
  '../mastra/agent-streaming'
);
const { listSuspendedMastraRuns } = await import('../mastra/suspended-run-discovery');

const SPECIALISTS = ['architecture', 'frontend', 'runtime', 'quality'] as const;
const DIRECTORY_TOOL = 'brainstrike.readWorkspaceDirectory';
const FILE_TOOL = 'brainstrike.readWorkspaceFile';

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

/** One model step that issues every call together, the way a provider batches parallel calls. */
function parallelCalls(calls: readonly [string, string, Record<string, unknown>][]) {
  // `toolCallParts` yields `[step-start, ...call parts, step-finish]`; the
  // merged step keeps the first call's boundaries around every call's middle.
  const parts = calls.map(([name, id, args]) => toolCallParts(name, id, args));
  const [first, ...rest] = parts;
  if (!first || parts.some((part) => part.length < 3)) {
    throw new Error('parallelCalls requires calls of the shape [start, ...parts, finish]');
  }
  return [...first.slice(0, -1), ...rest.flatMap((part) => part.slice(1, -1)), ...first.slice(-1)];
}

function specialistOf(prompt: string): (typeof SPECIALISTS)[number] | undefined {
  return SPECIALISTS.find((name) => prompt.includes(`specialist:${name}`));
}

// The prompt that failed four times in production between 2026-09-12 and
// 2026-09-14: "spin up 4 specialist subagents and compile their findings".
// Sean's real permission posture (`read: ask` with a per-tool allow for the
// file reader and none for the directory reader) is what makes every child
// pause. The root must finish with all four findings, every pause must surface
// LIVE, no child may pause twice, no allowed sibling may pause, and no child
// may delegate.
it('four specialist Explorer children complete under a read:ask posture with one grant', {
  timeout: 30_000,
}, async () => {
  const explore = BUILT_IN_PERSONAS.find((persona) => persona.id === 'explore');
  if (!explore) {
    throw new Error('Built-in Explorer is missing');
  }
  const identities: DelegatedConversationIdentity[] = [];
  const bound: DelegatedToolActionScope[] = [];
  const observedMessageIds = new Map<string, string>();
  // The desktop host admits every delegation through a durable budget; the
  // native in-flight backstop only counts when no such port exists.
  const reservations: string[] = [];
  const binding = {
    budget: {
      reserveStep: async (_scope: { threadId: string; resourceId: string }) => {
        const id = `reservation-${reservations.length}`;
        reservations.push(id);
        return { id, outputTokens: 8192, synthesis: false };
      },
      settleStep: async (_id: string, _outputTokens: number | undefined) => undefined,
    },
    ...createDelegatedConversationBinding(async (identity) => {
      identities.push(identity);
    }),
    bindRun: async (identity: DelegatedRunIdentity) => {
      const child = identities.find(
        (entry) =>
          entry.parentToolCallId === identity.parentToolCallId &&
          entry.parentRuntimeRunId === identity.parentRuntimeRunId
      );
      if (!child) {
        throw new Error('Native child was not bound');
      }
      const scope: DelegatedToolActionScope = {
        configuration: child.configuration,
        identity,
        ...(child.originalToolCall ? { originalToolCall: child.originalToolCall } : {}),
        resourceId: child.childResourceId,
        threadId: child.childThreadId,
      };
      const existing = bound.findIndex(
        (entry) => entry.identity.parentToolCallId === identity.parentToolCallId
      );
      if (existing >= 0) {
        bound.splice(existing, 1, scope);
      } else {
        bound.push(scope);
      }
      const messageId = observedMessageIds.get(identity.childRuntimeRunId);
      return { threadId: child.childThreadId, ...(messageId ? { messageId } : {}) };
    },
    claimToolAction: async () => undefined,
    finishToolActions: async () => undefined,
    prepareToolAction: async () => undefined,
    releaseUnexecutedToolAction: async () => undefined,
    resolveToolAction: async (action: { toolCallId: string }) =>
      bound.filter((scope) => scope.identity.parentToolCallId === action.toolCallId),
  };
  const childToolsSeen: string[][] = [];
  const rootResults: string[] = [];
  modelHolder.current = scriptedAgentModel((options) => {
    const isRoot = options.tools?.some((tool) => tool.name === 'agent-explore');
    if (isRoot) {
      if (hasToolResult(options, 'agent-explore')) {
        rootResults.push(JSON.stringify(options.prompt));
        return textParts('ROOT_REPORT compiled from four specialists');
      }
      return parallelCalls(
        SPECIALISTS.map((name) => [
          'agent-explore',
          `delegate-${name}`,
          { prompt: `Act as the ${name} specialist. specialist:${name}` },
        ])
      );
    }
    const name = specialistOf(JSON.stringify(options.prompt));
    if (!name) {
      throw new Error('Child prompt does not identify its specialist');
    }
    childToolsSeen.push(options.tools?.map((tool) => tool.name) ?? []);
    if (
      hasToolResult(options, 'brainstrike_readWorkspaceDirectory') &&
      hasToolResult(options, 'brainstrike_readWorkspaceFile')
    ) {
      return textParts(`SPECIALIST_${name.toUpperCase()}_FINDINGS`);
    }
    // One step, two calls: the ask-gated directory listing beside the allowed file read.
    return parallelCalls([
      ['brainstrike_readWorkspaceDirectory', `${name}-dir`, { path: '.', root: 'r' }],
      ['brainstrike_readWorkspaceFile', `${name}-file`, { path: 'AGENTS.md', root: 'r' }],
    ]);
  }).model;
  const storage = new InMemoryStore({ id: 'specialist-fanout' });
  const memory = new Memory({ options: { generateTitle: false }, storage });
  const readDirectory = vi.fn(async () => ({ entries: ['AGENTS.md', 'packages'] }));
  const readFile = vi.fn(async () => ({ content: '# AGENTS' }));
  const policy = {
    perToolOverrides: { [FILE_TOOL]: 'allow' as const },
    policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' } as const,
    riskByTool: buildNativeToolRiskMap(),
    yolo: false,
  };
  const options = {
    conversationBinding: binding,
    memory,
    model: 'gpt-5.4',
    personas: [explore],
    runtime: {
      apiKey: 'test-key',
      memory: { resourceId: 'fanout-resource', threadId: 'fanout-root' },
      model: 'gpt-5.4',
      permissionPolicy: policy,
      provider: 'openai',
    },
    storage,
    tools: {
      [DIRECTORY_TOOL]: createTool({
        description: 'List a directory',
        execute: readDirectory,
        id: DIRECTORY_TOOL,
        inputSchema: z.object({ path: z.string(), root: z.string() }),
      }),
      [FILE_TOOL]: createTool({
        description: 'Read a file',
        execute: readFile,
        id: FILE_TOOL,
        inputSchema: z.object({ path: z.string(), root: z.string() }),
      }),
    },
  } as const;
  const grantAll: ToolRiskCategory[] = ['read', 'edit', 'execute', 'mcp'];
  const grantedOptions = {
    ...options,
    requireToolApproval: true,
    runtime: { ...options.runtime, permissionPolicy: { ...policy, sessionGrants: grantAll } },
  };

  let chunks = await drain(
    await streamMastraAgent(
      [
        {
          id: 'user',
          parts: [
            {
              text: 'tell me all about the repo by spinning up 4 specialist subagents and compile their findings',
              type: 'text',
            },
          ],
          role: 'user',
        },
      ],
      options
    )
  );
  type LivePause = Extract<StreamChunk, { type: 'tool-approval-required' }>;
  // What a live renderer keeps: every notice it has seen and not yet answered,
  // across legs. A leg that resumes one child leaves its siblings parked.
  const outstanding = new Map<string, LivePause>();
  const legFinishReasons: string[] = [];
  const pauses: { toolName: string; leaf: string | undefined }[] = [];
  let rediscovered = 0;
  for (let leg = 0; leg < 12; leg += 1) {
    for (const frame of chunks) {
      if (frame.type === 'delegated-conversation-chunk') {
        observedMessageIds.set(frame.identity.childRuntimeRunId, frame.messageId);
      }
      if (frame.type === 'tool-approval-required') {
        outstanding.set(`${frame.runId}:${frame.toolCallId}`, frame);
      }
    }
    const finish = chunks.findLast((chunk) => chunk.type === 'message-finish');
    legFinishReasons.push(finish?.type === 'message-finish' ? finish.finishReason : 'none');
    let pending: { toolName: string; delegation?: { toolCallId: string } } & Parameters<
      typeof getToolActionTarget
    >[0];
    const [next] = outstanding;
    if (next) {
      outstanding.delete(next[0]);
      pending = next[1];
    } else {
      // What a reloaded renderer does: rediscover pauses that never surfaced live.
      const discovered = await listSuspendedMastraRuns(
        {
          resourceId: options.runtime.memory.resourceId,
          threadId: options.runtime.memory.threadId,
        },
        {
          ...options,
          delegatedSuspensionDiscovery: async (parent) =>
            bound.find(
              (scope) =>
                scope.identity.parentRuntimeRunId === parent.parentRuntimeRunId &&
                scope.identity.parentToolCallId === parent.parentToolCallId
            ),
        }
      );
      const first = discovered.approvals[0];
      if (!first) {
        break;
      }
      rediscovered += 1;
      pending = first;
    }
    pauses.push({ leaf: pending.delegation?.toolCallId, toolName: pending.toolName });
    // "Allow all tools this session" on the first prompt, then plain approvals.
    chunks = await drain(
      await streamMastraToolApprovalAction(
        { action: 'approve', ...getToolActionTarget(pending), toolName: pending.toolName },
        grantedOptions
      )
    );
  }

  const failures = chunks.filter(
    (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
  );
  expect(failures, JSON.stringify(failures)).toEqual([]);
  expect(outstanding.size, 'unanswered pauses at the leg budget').toBe(0);
  // The budget port admitted every child step; that is why the native
  // in-flight backstop never rejected the third and fourth children.
  expect(reservations.length).toBeGreaterThanOrEqual(SPECIALISTS.length);
  // Every pause must have surfaced LIVE; a pause only rediscovery finds is a stuck thread.
  expect(rediscovered, 'pauses that never surfaced live').toBe(0);
  expect(JSON.stringify(chunks)).toContain('ROOT_REPORT');
  for (const name of SPECIALISTS) {
    expect(JSON.stringify(rootResults)).toContain(`SPECIALIST_${name.toUpperCase()}_FINDINGS`);
  }
  // Every child pauses exactly once, on the ask tool only. The session grant
  // lifts the ask for later decisions; it does not answer pauses already parked.
  expect(pauses.map((pause) => pause.toolName)).toEqual(SPECIALISTS.map(() => DIRECTORY_TOOL));
  expect(new Set(pauses.map((pause) => pause.leaf)).size).toBe(SPECIALISTS.length);
  // A leg that leaves the run parked on the user ends as a tool-calls pause,
  // never as a synthetic finish; only the last leg completes the turn.
  expect(legFinishReasons).toEqual([...SPECIALISTS.map(() => 'tool-calls'), 'stop']);
  expect(readDirectory).toHaveBeenCalledTimes(SPECIALISTS.length);
  expect(readFile).toHaveBeenCalledTimes(SPECIALISTS.length);
  // Read-only children are leaves: no child ever saw a delegation tool.
  expect(childToolsSeen.length).toBeGreaterThan(0);
  expect(childToolsSeen.flat().some((name) => name.startsWith('agent-'))).toBe(false);
  await memory.settled();
});
