import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import { buildNativeToolRiskMap } from '@brainstrike/assistant-contract/tool-metadata';
import type { Agent, ToolsInput } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveScaledToolResultBudget } from '../../stream/tool-output-limits';
import { buildPersonaSubAgents, type DelegatedExecutionOptions } from '../build-persona-subagents';
import { createDelegatedConversationBinding } from '../delegated-conversation-binding';
import type { PermissionToolGateLogger } from '../permission-tool-gate';

/**
 * Provider compat on a CHILD agent. Run 6 of the live-app verifier
 * (2026-09-15): a live-resumed Explorer's response was persisted twice under
 * two message ids 1 ms apart (Mastra's sealed-boundary re-key) and its next
 * request 400ed "Duplicate item found with id rs_…" — a failed specialist,
 * "· 1 failed" on the root — because `OpenAIDuplicateItemCompat` reached
 * only the root's per-call processors and a worker's loop options, never a
 * read-only child.
 */
type LanguageModelV2 = Extract<MastraModelConfig, { specificationVersion: 'v2' }>;

const noopLogger: PermissionToolGateLogger = { info: () => undefined, warn: () => undefined };

const fakeModel: LanguageModelV2 = {
  doGenerate: (): Promise<never> => Promise.reject(new Error('unused in this test')),
  doStream: (): Promise<never> => Promise.reject(new Error('unused in this test')),
  modelId: 'fake',
  provider: 'fake',
  specificationVersion: 'v2',
  supportedUrls: {},
};

const TOOL_IDS = [
  'brainstrike.queryEmbeddingSpace',
  'brainstrike.grepSearch',
  'brainstrike.globWorkspace',
  'brainstrike.readWorkspaceFile',
  'brainstrike.readWorkspaceDirectory',
  'brainstrike.writeWorkspaceFile',
];

function makeGuardedTools(originalIds: readonly string[]) {
  const guardedTools: ToolsInput = {};
  const toolNameMap = new Map<string, string>();
  for (const originalId of originalIds) {
    const sanitizedId = originalId.replace(/[^a-zA-Z0-9_-]/g, '_');
    guardedTools[sanitizedId] = createTool({
      description: `tool ${sanitizedId}`,
      execute: () => Promise.resolve({ ok: true }),
      id: sanitizedId,
      inputSchema: z.object({}),
    });
    toolNameMap.set(sanitizedId, originalId);
  }
  return { guardedTools, toolNameMap };
}

const explorePersona: AssistantPersonaDefinition = {
  allowedToolIds: TOOL_IDS.filter((id) => id !== 'brainstrike.writeWorkspaceFile'),
  description: 'Explore persona',
  id: 'explore',
  instructions: 'Explore.',
  label: 'Explorer',
  maxSteps: 8,
};

const workerPersona: AssistantPersonaDefinition = {
  ...explorePersona,
  allowedToolIds: ['*'],
  id: 'worker',
  mode: 'worker',
};

const readAllowSnapshot: PermissionToolGateSnapshot = {
  defaultRisk: 'mcp',
  policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
  riskByTool: buildNativeToolRiskMap(),
  yolo: false,
};

const budget = resolveScaledToolResultBudget(131_072);

function baseOptions(provider: string) {
  return {
    subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    ...makeGuardedTools(TOOL_IDS),
    languageModel: fakeModel,
    logger: noopLogger,
    permissionSnapshot: readAllowSnapshot,
    provider,
    resolvedToolResultBudget: budget,
  };
}

async function compatCount(child: Agent | undefined): Promise<number> {
  if (!child) {
    throw new Error('Expected the persona child');
  }
  return (await child.listConfiguredInputProcessors()).filter(
    (processor) => 'id' in processor && processor.id === 'openai-duplicate-item-compat'
  ).length;
}

describe('persona child provider compat', () => {
  it('gives a read-only child on OpenAI the duplicate item-reference compat exactly once', async () => {
    const built = await buildPersonaSubAgents({
      ...baseOptions('openai'),
      personas: [explorePersona],
    });
    expect(await compatCount(built.subAgents['explore'])).toBe(1);
  });

  it('gives a read-only child on another provider none', async () => {
    const built = await buildPersonaSubAgents({
      ...baseOptions('anthropic'),
      personas: [explorePersona],
    });
    expect(await compatCount(built.subAgents['explore'])).toBe(0);
  });

  it('a worker already carries it through its loop options — never twice', async () => {
    const built = await buildPersonaSubAgents({
      ...baseOptions('openai'),
      conversationBinding: {
        ...createDelegatedConversationBinding(async () => undefined),
        bindRun: async () => ({ threadId: 'worker-child' }),
        claimToolAction: async () => undefined,
        finishToolActions: async () => undefined,
        prepareToolAction: async () => undefined,
        releaseUnexecutedToolAction: async () => undefined,
        resolveToolAction: async () => [],
      },
      hasStorage: true,
      localToolIds: new Set(TOOL_IDS.map((id) => id.replace(/[^a-zA-Z0-9_-]/g, '_'))),
      modelName: 'gpt-5.6-sol',
      personas: [workerPersona],
    });
    expect(await compatCount(built.subAgents['worker'])).toBe(1);
  });
});

describe('persona child prompt facts', () => {
  it('reports the exact instructions each child Agent was built with and the tools it kept', async () => {
    const built = await buildPersonaSubAgents({
      ...baseOptions('openai'),
      personas: [explorePersona],
    });
    const child = built.subAgents['explore'];
    if (!child) {
      throw new Error('Expected the persona child');
    }
    const facts = built.childPromptFacts.get('explore');
    // The permission gate keeps every read tool the persona names; the facts
    // are the gated set, never the persona's declared list.
    expect(facts?.toolNames).toEqual(built.personasById.get('explore')?.allowedToolIds);
    // MUTATION: recording `persona.instructions` instead of the string the
    // child was constructed with loses the "Available tools:" suffix.
    expect(facts?.instructions).toBe(await child.getInstructions());
    expect(facts?.instructions).toContain('Available tools: brainstrike.queryEmbeddingSpace');
    expect([...built.childPromptFacts.keys()]).toEqual([...built.personasById.keys()]);
  });
});

describe('worker recursion depth', () => {
  it.each([
    { expected: false, maxDepth: 1 },
    { expected: true, maxDepth: 2 },
  ])(
    "a worker may delegate further only below the request's maxDepth ($maxDepth)",
    async ({ expected, maxDepth }) => {
      const built = await buildPersonaSubAgents({
        ...baseOptions('openai'),
        conversationBinding: {
          ...createDelegatedConversationBinding(async () => undefined),
          bindRun: async () => ({ threadId: 'worker-child' }),
          budget: {
            admitInvocation: async () => ({ admitted: true as const }),
            reserveStep: async () => ({ id: 'unused', outputTokens: 512, synthesis: false }),
            settleStep: async () => undefined,
          },
          claimToolAction: async () => undefined,
          finishToolActions: async () => undefined,
          prepareToolAction: async () => undefined,
          releaseUnexecutedToolAction: async () => undefined,
          resolveToolAction: async () => [],
        },
        delegatedExecutionOptions: {},
        hasStorage: true,
        localToolIds: new Set(TOOL_IDS.map((id) => id.replace(/[^a-zA-Z0-9_-]/g, '_'))),
        modelName: 'gpt-5.6-sol',
        personas: [workerPersona],
        subagentSettings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxDepth },
      });
      const worker = built.subAgents['worker'];
      if (!worker) {
        throw new Error('Expected the worker child');
      }
      expect(Object.keys(await worker.listAgents()).length > 0).toBe(expected);
    }
  );
});

describe('delegated work queue', () => {
  it("is sized by the request's maxConcurrentWork", async () => {
    const delegatedExecutionOptions: DelegatedExecutionOptions = {};
    await buildPersonaSubAgents({
      ...baseOptions('openai'),
      delegatedExecutionOptions,
      personas: [explorePersona],
      subagentSettings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxConcurrentWork: 3 },
    });
    const queue = delegatedExecutionOptions.workQueue;
    if (!queue) {
      throw new Error('Expected the builder to create the work queue');
    }
    const granted: boolean[] = [false, false, false, false];
    for (const index of granted.keys()) {
      void queue.acquire().then(() => {
        granted[index] = true;
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(granted).toEqual([true, true, true, false]);
  });
});
