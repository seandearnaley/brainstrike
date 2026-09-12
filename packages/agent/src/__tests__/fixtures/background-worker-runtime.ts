import { addAbortListener } from 'node:events';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import { createTool, type ToolExecutionContext } from '@mastra/core/tools';
import { vi } from 'vitest';
import { z } from 'zod';
import {
  createMastraAgentRuntime,
  type MastraAgentRuntimeOptions,
} from '../../mastra/agent-runtime';
import {
  createDelegatedConversationBinding,
  type DelegatedCancellationControl,
  type DelegatedConversationIdentity,
  type DelegatedFollowupControl,
} from '../../mastra/delegated-conversation-binding';
import type { DelegatedRunIdentity } from '../../mastra/delegated-run-publication';
import type { DelegatedSuspensionResolver } from '../../mastra/delegated-suspension-discovery';
import { createPgliteMastraMemory } from '../../pglite-mastra-memory';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../../test-fixtures/scripted-agent-model';
import { createAskUserTool } from '../../tools/ask-user-tool';
import { createSubmitPlanTool } from '../../tools/submit-plan-tool';
import type { RuntimeData } from '../../types';

interface BackgroundFixture {
  backing: Awaited<ReturnType<typeof createPgliteMastraMemory>>;
  cancel: DelegatedCancellationControl;
  database: Awaited<ReturnType<typeof createEnginePglite>>;
  discoveryOptions: MastraAgentRuntimeOptions & {
    delegatedSuspensionDiscovery: DelegatedSuspensionResolver;
  };
  effect: ReturnType<
    typeof vi.fn<
      (_input: unknown, context?: ToolExecutionContext) => Promise<{ matches: string[] }>
    >
  >;
  entered: PromiseWithResolvers<void>;
  followup: (
    input: Parameters<DelegatedFollowupControl>[1],
    admit?: () => Promise<void>
  ) => Promise<void>;
  model: ReturnType<typeof scriptedAgentModel>;
  release: PromiseWithResolvers<void>;
  runtime: Awaited<ReturnType<typeof createMastraAgentRuntime>>;
  runtimeData: RuntimeData & { memory: { resourceId: string; threadId: string } };
  scope: { resourceId: string; threadId: string };
  toolSignals: AbortSignal[];
}

export async function createBackgroundFixture(
  requireApproval = false,
  signal?: AbortSignal,
  question: boolean | 'then-plan' | 'available' = false,
  background?: boolean
): Promise<BackgroundFixture> {
  const database = await createEnginePglite();
  const scope = { resourceId: 'background-owner', threadId: 'background-root' };
  const backing = await createPgliteMastraMemory({
    backgroundTaskScope: scope,
    database: {
      exec: (sql) => database.exec(sql),
      query: (sql, values) => database.query(sql, values ? [...values] : undefined),
      transaction: (operation) =>
        database.transaction((tx) =>
          operation({
            exec: (sql) => tx.exec(sql),
            query: (sql, values) => tx.query(sql, values ? [...values] : undefined),
          })
        ),
    },
    memoryOptions: { generateTitle: false, workingMemory: { enabled: false } },
  });
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const identities: DelegatedConversationIdentity[] = [];
  const runIdentities: DelegatedRunIdentity[] = [];
  const toolSignals: AbortSignal[] = [];
  const effect = vi.fn(async (_input: unknown, context?: ToolExecutionContext) => {
    const signal = context?.abortSignal;
    if (!signal) {
      throw new Error('Native background tool omitted its cancellation signal.');
    }
    toolSignals.push(signal);
    const aborted = Promise.withResolvers<never>();
    const subscription = addAbortListener(signal, () => aborted.reject(signal.reason));
    entered.resolve();
    try {
      await Promise.race([release.promise, aborted.promise]);
      return { matches: ['BACKGROUND_EVIDENCE'] };
    } finally {
      subscription[Symbol.dispose]();
    }
  });
  const model = scriptedAgentModel((options) => {
    if (options.tools?.some((tool) => tool.name === 'agent-explore')) {
      if (!hasToolResult(options, 'agent-explore')) {
        return toolCallParts('agent-explore', 'background-child', {
          // Omission preserves the production default in existing background cases.
          ...(background === undefined ? {} : { _background: { enabled: background } }),
          prompt: 'Read background evidence',
        });
      }
      return textParts(
        JSON.stringify(options.prompt).includes('CHILD_FINAL_EVIDENCE')
          ? 'PARENT_FINAL_OUTCOME'
          : 'PARENT_USEFUL_PROGRESS'
      );
    }
    if (question && question !== 'available' && !hasToolResult(options, 'brainstrike_askUser')) {
      return toolCallParts('brainstrike_askUser', 'background-question', {
        question: 'Which evidence should I inspect?',
      });
    }
    if (question === 'then-plan' && !hasToolResult(options, 'brainstrike_submitPlan')) {
      return toolCallParts('brainstrike_submitPlan', 'background-plan', {
        overview: 'Read the selected evidence.',
        steps: [{ title: 'Read evidence' }],
        title: 'Inspect evidence',
      });
    }
    return hasToolResult(options, 'brainstrike_grepSearch')
      ? textParts('CHILD_FINAL_EVIDENCE')
      : toolCallParts('brainstrike_grepSearch', 'background-read', { pattern: 'evidence' });
  });
  const runtimeData = {
    apiKey: 'test-key',
    memory: scope,
    model: 'gpt-5.4',
    provider: 'openai',
    ...(signal ? { signal } : {}),
  } as const;
  let cancel: DelegatedCancellationControl | undefined;
  let followup: DelegatedFollowupControl | undefined;
  const options = {
    backgroundTaskScope: scope,
    conversationBinding: {
      claimToolAction: async () => {},
      finishToolActions: async () => {},
      prepareToolAction: async () => {},
      registerCancellation: (control: DelegatedCancellationControl) => {
        cancel = control;
        return () => {
          cancel = undefined;
        };
      },
      registerFollowup: (control: DelegatedFollowupControl) => {
        followup = control;
        return () => {
          followup = undefined;
        };
      },
      releaseUnexecutedToolAction: async () => {},
      resolveToolAction: async (action: { runId: string; toolCallId: string }) => {
        const identity = runIdentities.find(
          (candidate) =>
            candidate.parentRuntimeRunId === action.runId &&
            candidate.parentToolCallId === action.toolCallId
        );
        const child = identities.find(
          (candidate) =>
            candidate.parentRuntimeRunId === action.runId &&
            candidate.parentToolCallId === action.toolCallId
        );
        if (!(identity && child)) {
          throw new Error('Unknown test invocation');
        }
        return [
          {
            configuration: child.configuration,
            identity,
            resourceId: child.childResourceId,
            threadId: child.childThreadId,
            ...(child.originalToolCall ? { originalToolCall: child.originalToolCall } : {}),
          },
        ];
      },
      ...createDelegatedConversationBinding(async (identity) => {
        identities.push(identity);
      }),
      bindRun: async (identity: DelegatedRunIdentity) => {
        runIdentities.push(identity);
        const child = identities.find(
          (entry) => entry.parentToolCallId === identity.parentToolCallId
        );
        if (!child) {
          throw new Error('Missing native child identity');
        }
        const { messages } = await backing.memory.recall({
          perPage: false,
          resourceId: child.childResourceId,
          threadId: child.childThreadId,
        });
        const previous = messages.findLast((message) => message.role === 'assistant');
        return { threadId: child.childThreadId, ...(previous ? { messageId: previous.id } : {}) };
      },
    },
    getDelegatedSystemContext: () => [],
    memory: backing.memory,
    model: runtimeData.model,
    modelOverride: model.model,
    personas: [
      {
        allowedToolIds: [
          'brainstrike.grepSearch',
          ...(question ? ['brainstrike.askUser', 'brainstrike.submitPlan'] : []),
        ],
        description: 'Read evidence',
        id: 'explore',
        instructions: 'Read evidence',
        label: 'Explorer',
        maxSteps: 4,
      },
    ],
    runtime: runtimeData,
    storage: backing.storage,
    tools: {
      ...(question
        ? {
            'brainstrike.askUser': createAskUserTool(),
            'brainstrike.submitPlan': createSubmitPlanTool(),
          }
        : {}),
      'brainstrike.grepSearch': createTool({
        description: 'Read evidence',
        execute: effect,
        id: 'brainstrike.grepSearch',
        inputSchema: z.object({ pattern: z.string() }),
        requireApproval,
      }),
    },
  };
  const runtime = await createMastraAgentRuntime(options);
  return {
    backing,
    cancel: (targets: Parameters<DelegatedCancellationControl>[0]) => {
      if (!cancel) {
        throw new Error('Missing production cancellation owner');
      }
      return cancel(targets);
    },
    database,
    discoveryOptions: {
      ...options,
      delegatedSuspensionDiscovery: async (parent: {
        parentRuntimeRunId: string;
        parentToolCallId: string;
      }) => {
        const identity = runIdentities.find(
          (candidate) =>
            candidate.parentRuntimeRunId === parent.parentRuntimeRunId &&
            candidate.parentToolCallId === parent.parentToolCallId
        );
        const child = identities.find(
          (candidate) =>
            candidate.parentRuntimeRunId === parent.parentRuntimeRunId &&
            candidate.parentToolCallId === parent.parentToolCallId
        );
        if (!(identity && child)) {
          return;
        }
        return { identity, resourceId: child.childResourceId, threadId: child.childThreadId };
      },
    },
    effect,
    entered,
    followup: (input: Parameters<DelegatedFollowupControl>[1], admit = async () => {}) => {
      const child = identities[0];
      const identity = runIdentities[0];
      if (!(followup && child && identity)) {
        throw new Error('Missing production child follow-up owner');
      }
      return followup(
        {
          identity,
          personaId: child.personaId,
          resourceId: child.childResourceId,
          runId: identity.childRuntimeRunId,
          threadId: child.childThreadId,
        },
        input,
        admit
      );
    },
    model,
    release,
    runtime,
    runtimeData,
    scope,
    toolSignals,
  };
}
