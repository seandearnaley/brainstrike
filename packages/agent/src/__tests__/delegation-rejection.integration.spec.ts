import { buildNativeToolRiskMap } from '@brainstrike/assistant-contract';
import {
  BUILT_IN_PERSONAS,
  SUBAGENT_REJECTED_OUTCOME,
} from '@brainstrike/assistant-contract/personas';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createDelegatedConversationBinding,
  type DelegatedConversationIdentity,
} from '../mastra/delegated-conversation-binding';
import type { DelegatedRunIdentity } from '../mastra/delegated-run-publication';
import {
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
const { streamMastraAgent } = await import('../mastra/agent-streaming');

/** The request's per-turn invocation limit; the backstop case asks for one more. */
const MAX_INVOCATIONS = 8;

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

/** One model step that issues every call together, the way a provider batches parallel calls. */
function parallelCalls(calls: readonly [string, string, Record<string, unknown>][]) {
  const parts = calls.map(([name, id, args]) => toolCallParts(name, id, args));
  const [first, ...rest] = parts;
  if (!first || parts.some((part) => part.length < 3)) {
    throw new Error('parallelCalls requires calls of the shape [start, ...parts, finish]');
  }
  return [...first.slice(0, -1), ...rest.flatMap((part) => part.slice(1, -1)), ...first.slice(-1)];
}

function subagentEvents(chunks: readonly StreamChunk[]) {
  return chunks
    .filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'run-event' }> =>
        chunk.type === 'run-event' && chunk.event.kind.startsWith('subagent.')
    )
    .map((chunk) => ({
      call: chunk.event.metadata?.['parentToolCallId'],
      kind: chunk.event.kind,
      outcome: chunk.event.metadata?.['outcome'],
      status: chunk.event.status,
    }));
}

// BST-1751. Mastra answers a refused delegation with its own writer under the
// PARENT's run id and a `[Delegation Rejected] …` tool result; no child ever
// starts, so there is no native identity to bind. The projection used to try
// anyway and the identity error killed the root run and cancelled every
// sibling (thread-f6be9761). A refusal — by the in-memory backstops or by the
// host's durable budget at delegation start — must reach the model as a tool
// result and the timeline as a rejected delegation while the root completes.
it.for([
  { admitted: 'per-turn backstop', refuse: 'backstop' },
  { admitted: 'durable budget at start', refuse: 'host' },
  // Two siblings admitted at start can still lose the last slot at persist
  // time. That refusal runs inside the child's input processing, before the
  // child streams a single part, so there is nothing for the parent to bind:
  // Mastra turns it into that delegation's tool error and the root continues.
  { admitted: 'late reservation at persist', refuse: 'persist' },
] as const)(
  'a refused delegation ($admitted) rejects that call and the root completes',
  { timeout: 30_000 },
  async ({ refuse }) => {
    const explore = BUILT_IN_PERSONAS.find((persona) => persona.id === 'explore');
    if (!explore) {
      throw new Error('Built-in Explorer is missing');
    }
    const total = refuse === 'backstop' ? MAX_INVOCATIONS + 1 : 2;
    const refused = `delegate-${total}`;
    const hostReason = 'Delegation depth limit reached (3 descendant levels).';
    const identities: DelegatedConversationIdentity[] = [];
    let admissions = 0;
    const binding = {
      budget: {
        admitInvocation: async (_scope: { parentThreadId: string; parentResourceId: string }) => {
          admissions += 1;
          return refuse === 'host' && admissions === total
            ? { admitted: false as const, reason: hostReason }
            : { admitted: true as const };
        },
        reserveStep: async (_scope: { threadId: string; resourceId: string }) => ({
          id: `reservation-${identities.length}`,
          outputTokens: 8192,
          synthesis: false as const,
        }),
        settleStep: async (_id: string, _outputTokens: number | undefined) => undefined,
      },
      ...createDelegatedConversationBinding(async (identity) => {
        if (refuse === 'persist' && identity.parentToolCallId === refused) {
          throw new Error(hostReason);
        }
        identities.push(identity);
      }),
      // The desktop host: a run the graph never admitted has no identity.
      bindRun: async (identity: DelegatedRunIdentity) => {
        const child = identities.find(
          (entry) =>
            entry.parentToolCallId === identity.parentToolCallId &&
            entry.parentRuntimeRunId === identity.parentRuntimeRunId
        );
        if (!child) {
          throw new Error(
            'Delegated conversation identity is missing, unauthorized or conflicts with its persisted binding.'
          );
        }
        return { threadId: child.childThreadId };
      },
      claimToolAction: async () => undefined,
      finishToolActions: async () => undefined,
      prepareToolAction: async () => undefined,
      releaseUnexecutedToolAction: async () => undefined,
      resolveToolAction: async () => [],
    };
    const rootPrompts: string[] = [];
    modelHolder.current = scriptedAgentModel((options) => {
      const isRoot = options.tools?.some((tool) => tool.name === 'agent-explore');
      if (!isRoot) {
        const index = /specialist:(\d+)/.exec(JSON.stringify(options.prompt))?.[1];
        return textParts(`CHILD_${index}_DONE`);
      }
      const prompt = JSON.stringify(options.prompt);
      if (prompt.includes('CHILD_1_DONE') || prompt.includes('[Delegation Rejected]')) {
        rootPrompts.push(prompt);
        return textParts('ROOT_REPORT');
      }
      return parallelCalls(
        Array.from({ length: total }, (_, index) => [
          'agent-explore',
          `delegate-${index + 1}`,
          { prompt: `specialist:${index + 1}` },
        ])
      );
    }).model;
    const storage = new InMemoryStore({ id: `delegation-rejection-${refuse}` });
    const memory = new Memory({ options: { generateTitle: false }, storage });
    const chunks = await drain(
      await streamMastraAgent(
        [{ id: 'user', parts: [{ text: 'fan out', type: 'text' }], role: 'user' }],
        {
          conversationBinding: binding,
          memory,
          model: 'gpt-5.4',
          personas: [explore],
          runtime: {
            apiKey: 'test-key',
            memory: { resourceId: 'rejection-resource', threadId: 'rejection-root' },
            model: 'gpt-5.4',
            permissionPolicy: {
              policies: { edit: 'allow', execute: 'allow', mcp: 'allow', read: 'allow' },
              riskByTool: buildNativeToolRiskMap(),
              yolo: false,
            },
            provider: 'openai',
            subagentSettings: {
              ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
              maxInvocations: MAX_INVOCATIONS,
            },
          },
          storage,
          // A persona registers its delegation tool only with a usable tool set.
          tools: {
            'brainstrike.readWorkspaceFile': createTool({
              description: 'Read a file',
              execute: async () => ({ content: '# AGENTS' }),
              id: 'brainstrike.readWorkspaceFile',
              inputSchema: z.object({ path: z.string(), root: z.string() }),
            }),
          },
        }
      )
    );

    await memory.settled();
    const failures = chunks.filter(
      (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'run.failed'
    );
    expect(failures, JSON.stringify(failures)).toEqual([]);
    expect(JSON.stringify(chunks)).toContain('ROOT_REPORT');
    const events = subagentEvents(chunks);
    expect(events.filter((event) => event.kind === 'subagent.finished')).toHaveLength(total - 1);
    if (refuse === 'persist') {
      // A late refusal is a hard delegation failure, not a recorded rejection.
      expect(events.filter((event) => event.kind === 'subagent.failed')).toEqual([
        { call: refused, kind: 'subagent.failed', outcome: undefined, status: 'failed' },
      ]);
    } else {
      // The model read the refusal as that call's tool result.
      expect(rootPrompts.join('\n')).toContain('[Delegation Rejected]');
      if (refuse === 'host') {
        expect(rootPrompts.join('\n')).toContain(hostReason);
      }
      expect(events.filter((event) => event.kind === 'subagent.failed')).toEqual([
        {
          call: refused,
          kind: 'subagent.failed',
          outcome: SUBAGENT_REJECTED_OUTCOME,
          status: 'failed',
        },
      ]);
    }
    // A refusal admits nothing: no child was persisted for the refused call.
    expect(identities.map((identity) => identity.parentToolCallId)).not.toContain(refused);
    expect(identities).toHaveLength(total - 1);
  }
);
