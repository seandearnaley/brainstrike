import { deriveEffectiveInputBudget } from '@brainstrike/assistant-contract';
import { GEMMA4_E2B_MODEL_ID } from '@brainstrike/assistant-contract/local-llm';
import {
  type AssistantPersonaDefinition,
  PersonaToolRiskViolationError,
} from '@brainstrike/assistant-contract/personas';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import { buildNativeToolRiskMap } from '@brainstrike/assistant-contract/tool-metadata';
import { type Agent, MessageList, type ToolsInput } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { createTool, noopObserve } from '@mastra/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createListingOnlyModel } from '../../providers/listing-only-model';
import {
  decodedTextModelOutputChars,
  resolveScaledToolResultBudget,
  resolveToolResultBudgetForModel,
  type ScaledToolResultBudget,
} from '../../stream/tool-output-limits';
import { createAskUserTool } from '../../tools/ask-user-tool';
import { createSubmitPlanTool } from '../../tools/submit-plan-tool';
import { buildPersonaSubAgents } from '../build-persona-subagents';
import { createDelegatedConversationBinding } from '../delegated-conversation-binding';
import type { PermissionToolGateLogger } from '../permission-tool-gate';
import { ProjectionAwareTokenLimiter } from '../projection-aware-token-limiter';
import { applyToolModelOutputProjections, getActiveToolResultBudget } from '../tool-model-output';
import { BrainstrikeToolSearchProcessor } from '../tool-search-runtime';

// Mastra vendors its own AI SDK v5 provider types (the workspace
// `@ai-sdk/provider` is a different major and is NOT assignable), so extract
// the v2 language-model member straight from the config union the factory
// accepts.
type LanguageModelV2 = Extract<MastraModelConfig, { specificationVersion: 'v2' }>;

const noopLogger: PermissionToolGateLogger = {
  info: () => undefined,
  warn: () => undefined,
};

const ANCHOR_TOOL_RESULT_BUDGET = resolveScaledToolResultBudget(131_072);

function assertDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

// A minimal valid LanguageModelV2 so the child Agent can resolve its model
// config when we inspect its tools; buildPersonaSubAgents never invokes it.
const fakeModel: LanguageModelV2 = {
  doGenerate: (): Promise<never> => Promise.reject(new Error('unused in this test')),
  doStream: (): Promise<never> => Promise.reject(new Error('unused in this test')),
  modelId: 'fake',
  provider: 'fake',
  specificationVersion: 'v2',
  supportedUrls: {},
};

function makeTool(id: string) {
  return createTool({
    description: `tool ${id}`,
    execute: () => Promise.resolve({ ok: true }),
    id,
    inputSchema: z.object({}),
  });
}

/**
 * Build a guarded tool map + sanitized→original name map for the given original
 * tool ids, mirroring how sanitizeTools keys the parent map (dots → underscores).
 */
function makeGuardedTools(originalIds: readonly string[]) {
  const guardedTools: ToolsInput = {};
  const toolNameMap = new Map<string, string>();
  for (const originalId of originalIds) {
    const sanitizedId = originalId.replace(/[^a-zA-Z0-9_-]/g, '_');
    guardedTools[sanitizedId] = makeTool(sanitizedId);
    toolNameMap.set(sanitizedId, originalId);
  }
  return { guardedTools, toolNameMap };
}

const explorePersona: AssistantPersonaDefinition = {
  allowedToolIds: [
    'brainstrike.queryEmbeddingSpace',
    'brainstrike.grepSearch',
    'brainstrike.globWorkspace',
    'brainstrike.readWorkspaceFile',
    'brainstrike.readWorkspaceDirectory',
  ],
  description: 'Explore persona',
  id: 'explore',
  instructions: 'Explore.',
  label: 'Explorer',
  maxSteps: 8,
};

const ALL_TOOL_IDS = [
  'brainstrike.queryEmbeddingSpace',
  'brainstrike.grepSearch',
  'brainstrike.globWorkspace',
  'brainstrike.readWorkspaceFile',
  'brainstrike.readWorkspaceDirectory',
  'brainstrike.writeWorkspaceFile',
];

const readAllowSnapshot: PermissionToolGateSnapshot = {
  defaultRisk: 'mcp',
  policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
  riskByTool: buildNativeToolRiskMap(),
  yolo: false,
};

const readAskSnapshot: PermissionToolGateSnapshot = {
  defaultRisk: 'mcp',
  policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' },
  riskByTool: buildNativeToolRiskMap(),
  yolo: false,
};

async function childToolKeys(agent: Agent): Promise<string[]> {
  const tools = await agent.getToolsForExecution({});
  return Object.keys(tools).sort();
}

const workerPersona: AssistantPersonaDefinition = {
  ...explorePersona,
  allowedToolIds: ['*'],
  id: 'worker',
  mode: 'worker',
};
function workerOptions(persona = workerPersona) {
  const ids = [
    ...ALL_TOOL_IDS,
    'brainstrike.manageTaskList',
    'linear.get_issue',
    'linear.save_issue',
  ];
  return {
    ...makeGuardedTools(ids),
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
    languageModel: fakeModel,
    localToolIds: new Set(
      ids
        .filter((id) => id.startsWith('brainstrike.'))
        .map((id) => id.replace(/[^a-zA-Z0-9_-]/g, '_'))
    ),
    logger: noopLogger,
    modelName: 'gpt-5.6-sol',
    permissionSnapshot: readAllowSnapshot,
    personas: [persona],
    provider: 'openai',
    resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
  };
}
async function workerCatalog(child: Agent) {
  const processors = await child.listConfiguredInputProcessors();
  const processor = processors.find((value) => value instanceof BrainstrikeToolSearchProcessor);
  if (!(processor instanceof BrainstrikeToolSearchProcessor)) {
    throw new Error('Expected canonical worker discovery');
  }
  const messageList = new MessageList();
  return processor.processInputStep({
    abort(reason?: string): never {
      throw new Error(reason ?? 'processor aborted');
    },
    messageList,
    messages: messageList.get.all.db(),
    model: createListingOnlyModel(),
    retryCount: 0,
    state: {},
    stepNumber: 0,
    steps: [],
    systemMessages: [],
    tools: await child.getToolsForExecution({}),
  });
}
describe('worker tool admission', () => {
  it('derives the pinned worker input limit from its own model window', async () => {
    const options = workerOptions({
      ...workerPersona,
      model: { modelId: 'qwen3', provider: 'ollama' },
    });
    const result = await buildPersonaSubAgents({ ...options, resolvePinnedModel: () => fakeModel });
    const child = assertDefined(result.subAgents['worker'], 'Expected pinned worker');
    const limiter = (await child.listConfiguredInputProcessors()).find(
      (processor) => processor instanceof ProjectionAwareTokenLimiter
    );
    if (!(limiter instanceof ProjectionAwareTokenLimiter)) {
      throw new Error('Missing worker context limiter');
    }
    const childWindow = resolveToolResultBudgetForModel('ollama', 'qwen3').contextWindow;
    expect(childWindow).not.toBe(options.resolvedToolResultBudget.contextWindow);
    expect(limiter.getMaxTokens()).toBe(deriveEffectiveInputBudget(childWindow));
  });

  it.each(['allow', 'deny'] as const)(
    'advertises wildcard artifact delegation only when its actual reader is %s',
    async (permission) => {
      const options = workerOptions();
      const reader = 'brainstrike.readToolOutputArtifact';
      const result = await buildPersonaSubAgents({
        ...options,
        ...makeGuardedTools([reader, 'brainstrike.grepSearch']),
        localToolIds: new Set(['brainstrike_readToolOutputArtifact', 'brainstrike_grepSearch']),
        permissionSnapshot: {
          ...readAllowSnapshot,
          perToolOverrides: { [reader]: permission },
        },
      });
      expect(result.subAgents['worker']).toBeDefined();
      expect(result.artifactReaderDelegationTools).toEqual(
        permission === 'allow' ? ['agent-worker'] : []
      );
    }
  );

  it('visibly omits a worker pinned to the embedded local model before resolving it', async () => {
    const resolvePinnedModel = vi.fn(() => fakeModel);
    const warn = vi.fn();
    const result = await buildPersonaSubAgents({
      ...workerOptions({ ...workerPersona, model: { modelId: 'local-worker', provider: 'local' } }),
      logger: { ...noopLogger, warn },
      resolvePinnedModel,
    });
    expect(result.subAgents).toEqual({});
    expect(resolvePinnedModel).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: 'subagent_worker_local_model_unavailable' })
    );
  });
  it('visibly omits a worker without its host catalog', async () => {
    const { localToolIds: _removed, ...options } = workerOptions();
    const warn = vi.fn();
    const result = await buildPersonaSubAgents({ ...options, logger: { ...noopLogger, warn } });
    expect(result.subAgents).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: 'subagent_worker_catalog_unavailable' })
    );
  });
  it('keeps deferred catalog names out of worker instructions', async () => {
    const result = await buildPersonaSubAgents(workerOptions());
    const child = assertDefined(result.subAgents['worker'], 'Expected worker');
    expect(await child.getInstructions()).toBe(workerPersona.instructions);
  });

  it.each([
    'storage',
    'bindRun',
    'claimToolAction',
    'finishToolActions',
    'prepareToolAction',
    'releaseUnexecutedToolAction',
    'resolveToolAction',
  ] as const)('omits the worker without durable %s capability', async (missing) => {
    const options = workerOptions();
    const { [missing === 'storage' ? 'bindRun' : missing]: _removed, ...partialBinding } =
      options.conversationBinding;
    const result = await buildPersonaSubAgents({
      ...options,
      ...(missing === 'storage' ? { hasStorage: false } : { conversationBinding: partialBinding }),
    });
    expect(result.subAgents).toEqual({});
    expect(result.delegationToolPersonas.size).toBe(0);
  });
  it('keeps only exact eligible native and MCP tools after deny gating', async () => {
    const options = workerOptions({
      ...workerPersona,
      allowedToolIds: [
        'brainstrike.readWorkspaceFile',
        'brainstrike.writeWorkspaceFile',
        'linear.get_issue',
      ],
    });
    const result = await buildPersonaSubAgents({
      ...options,
      permissionSnapshot: {
        ...readAllowSnapshot,
        policies: { ...readAllowSnapshot.policies, edit: 'deny' },
      },
    });
    const child = assertDefined(result.subAgents['worker'], 'Expected narrowed worker');
    const catalog = await workerCatalog(child);
    const inventory = await catalog.tools.list_available_tools.execute?.(
      {},
      { observe: noopObserve }
    );
    expect(inventory).toMatchObject({ total: 1 });
    expect(await childToolKeys(child)).toContain('brainstrike_readWorkspaceFile');
    if (!(inventory && 'tools' in inventory)) {
      throw new Error('Expected a valid worker catalog result');
    }
    expect(inventory.tools.map(({ name }) => name)).toEqual(['linear_get_issue']);
    for (const name of [
      'linear_save_issue',
      'brainstrike_writeWorkspaceFile',
      'brainstrike_manageTaskList',
    ]) {
      await expect(
        catalog.tools.load_tool.execute?.({ toolName: name }, { observe: noopObserve })
      ).resolves.toMatchObject({
        success: false,
      });
    }
    await expect(
      catalog.tools.load_tool.execute?.({ toolName: 'linear_get_issue' }, { observe: noopObserve })
    ).resolves.toMatchObject({ success: true });
  });
  it('captures the effective wildcard catalog for admission and does not widen it on resume', async () => {
    const initial = await buildPersonaSubAgents(workerOptions());
    const admitted = assertDefined(initial.personasById.get('worker'), 'Missing admitted worker');
    expect(admitted.allowedToolIds).not.toContain('*');
    expect(admitted.allowedToolIds).not.toContain('brainstrike.manageTaskList');
    const options = workerOptions();
    options.guardedTools['new_write'] = makeTool('new_write');
    options.toolNameMap.set('new_write', 'new.write');
    const resumed = await buildPersonaSubAgents({
      ...options,
      delegatedPersonaSnapshots: [admitted],
    });
    expect(resumed.personasById.get('worker')?.allowedToolIds).toEqual(admitted.allowedToolIds);
    expect(resumed.personasById.get('worker')?.allowedToolIds).not.toContain('new.write');
  });

  it('excludes the parent task list from a wildcard worker', async () => {
    const result = await buildPersonaSubAgents(workerOptions());
    const child = assertDefined(result.subAgents['worker'], 'Expected wildcard worker');
    const catalog = await workerCatalog(child);
    expect(await childToolKeys(child)).not.toContain('brainstrike_manageTaskList');
    await expect(
      catalog.tools.load_tool.execute?.(
        { toolName: 'brainstrike_manageTaskList' },
        { observe: noopObserve }
      )
    ).resolves.toMatchObject({ success: false });
    expect(await childToolKeys(child)).toContain('brainstrike_writeWorkspaceFile');
  });
  it('omits a failed pinned worker without substituting the parent model', async () => {
    const result = await buildPersonaSubAgents({
      ...workerOptions({
        ...workerPersona,
        model: { modelId: 'missing-model', provider: 'anthropic' },
      }),
      resolvePinnedModel: () => {
        throw new Error('missing credentials');
      },
    });
    expect(result.subAgents).toEqual({});
    expect(result.delegationToolPersonas.size).toBe(0);
    expect(result.personasById.size).toBe(0);
  });
});
describe('buildPersonaSubAgents', () => {
  it('does not advertise recursive agents without durable host budgets', async () => {
    const result = await buildPersonaSubAgents({
      ...workerOptions(),
      delegatedExecutionOptions: {},
    });
    const child = assertDefined(result.subAgents['worker'], 'Expected worker');
    expect((await childToolKeys(child)).some((key) => key.startsWith('agent-'))).toBe(false);
  });

  it('builds an explore child with exactly its 5 gated tools, no agents, no memory (read:allow)', async () => {
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    const result = await buildPersonaSubAgents({
      guardedTools,
      languageModel: fakeModel,
      logger: noopLogger,
      permissionSnapshot: readAllowSnapshot,
      personas: [explorePersona],
      provider: 'openai',
      resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
      toolNameMap,
    });

    const child = assertDefined(result.subAgents['explore'], 'Expected explore subagent');
    expect(result.delegationToolPersonas.get('agent-explore')).toBe('explore');
    expect(result.personasById.get('explore')).toEqual(explorePersona);
    expect(child.hasOwnMemory()).toBe(false);
    expect(await child.listConfiguredOutputProcessors()).toEqual([
      expect.objectContaining({ id: 'brainstrike-response-boundaries' }),
    ]);

    const keys = await childToolKeys(child);
    expect(keys).toEqual([
      'brainstrike_globWorkspace',
      'brainstrike_grepSearch',
      'brainstrike_queryEmbeddingSpace',
      'brainstrike_readWorkspaceDirectory',
      'brainstrike_readWorkspaceFile',
    ]);
    // No nesting: the child has no agent-* delegation tools of its own.
    expect(keys.some((key) => key.startsWith('agent-'))).toBe(false);
  });

  it('gives the child a description carrying its DERIVED step budget', async () => {
    // The wiring proof, not the arithmetic one. Mastra turns a child Agent's
    // `description` into the `agent-<id>` tool description, which is the only
    // thing the supervisor reads when sizing a delegation. A regression that
    // passed `persona.description` straight through would restore the
    // undisclosed-budget bug while `delegationDescriptionForPersona`'s own unit
    // tests stayed green — so this asserts the value that actually reaches the
    // model, on a persona whose cap (8) differs from any built-in's.
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    const result = await buildPersonaSubAgents({
      guardedTools,
      languageModel: fakeModel,
      logger: noopLogger,
      permissionSnapshot: readAllowSnapshot,
      personas: [explorePersona],
      provider: 'openai',
      resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
      toolNameMap,
    });

    const child = assertDefined(result.subAgents['explore'], 'Expected explore subagent');
    const description = await child.getDescription();
    expect(description).toContain('Explore persona');
    expect(description).toContain('at most 8 steps');
  });

  it('registers no subagent when the policy gates every persona tool to ask (read:ask)', async () => {
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    const result = await buildPersonaSubAgents({
      guardedTools,
      languageModel: fakeModel,
      logger: noopLogger,
      permissionSnapshot: readAskSnapshot,
      personas: [explorePersona],
      provider: 'openai',
      resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
      toolNameMap,
    });
    expect(result.subAgents['explore']).toBeUndefined();
    expect(result.delegationToolPersonas.size).toBe(0);
  });

  it('keeps per-tool read approvals only with native storage and complete durable host control', async () => {
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    const conversationBinding = {
      ...createDelegatedConversationBinding(async () => undefined),
      bindRun: async () => ({ threadId: 'child' }),
      claimToolAction: async () => undefined,
      finishToolActions: async () => undefined,
      prepareToolAction: async () => undefined,
      releaseUnexecutedToolAction: async () => undefined,
      resolveToolAction: async () => [],
    };
    const warnings: unknown[] = [];
    const logger: PermissionToolGateLogger = {
      ...noopLogger,
      warn: (message, details) => {
        warnings.push({ details, message });
      },
    };
    const options = {
      conversationBinding,
      guardedTools,
      hasStorage: true,
      languageModel: fakeModel,
      logger,
      permissionSnapshot: readAskSnapshot,
      personas: [explorePersona],
      provider: 'openai',
      resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
      toolNameMap,
    };
    const child = assertDefined(
      (await buildPersonaSubAgents(options)).subAgents['explore'],
      'Expected resumable read-only child'
    );
    const tools = await child.getToolsForExecution({});
    expect(Object.keys(tools)).toHaveLength(5);
    for (const tool of Object.values(tools)) {
      expect(tool).toHaveProperty('requireApproval', true);
    }
    expect(
      (await buildPersonaSubAgents({ ...options, hasStorage: false })).subAgents['explore']
    ).toBeUndefined();
    expect(warnings).toContainEqual({
      details: { code: 'subagent_persona_empty_toolset', personaId: 'explore' },
      message: 'Persona has no available tools after gating; not registering',
    });
    expect(
      (
        await buildPersonaSubAgents({
          ...options,
          conversationBinding: createDelegatedConversationBinding(async () => undefined),
        })
      ).subAgents['explore']
    ).toBeUndefined();
  });

  it.each(['no-storage', 'incomplete-host', 'complete-host'] as const)(
    'self-suspending read tools require durable child control (%s)',
    async (capability) => {
      const ids = [
        'brainstrike.readWorkspaceFile',
        'brainstrike.askUser',
        'brainstrike.submitPlan',
      ];
      const { guardedTools, toolNameMap } = makeGuardedTools(ids);
      guardedTools['brainstrike_askUser'] = createAskUserTool();
      guardedTools['brainstrike_submitPlan'] = createSubmitPlanTool();
      expect(guardedTools['brainstrike_askUser']).toHaveProperty('suspendSchema');
      expect(guardedTools['brainstrike_submitPlan']).toHaveProperty('suspendSchema');
      const baseBinding = {
        ...createDelegatedConversationBinding(async () => undefined),
        bindRun: async () => ({ threadId: 'child' }),
        claimToolAction: async () => undefined,
        finishToolActions: async () => undefined,
        releaseUnexecutedToolAction: async () => undefined,
        resolveToolAction: async () => [],
      };
      const conversationBinding =
        capability === 'incomplete-host'
          ? baseBinding
          : { ...baseBinding, prepareToolAction: async () => undefined };
      const result = await buildPersonaSubAgents({
        conversationBinding,
        guardedTools,
        hasStorage: capability !== 'no-storage',
        languageModel: fakeModel,
        logger: noopLogger,
        permissionSnapshot: readAllowSnapshot,
        personas: [{ ...explorePersona, allowedToolIds: ids }],
        provider: 'openai',
        resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
        toolNameMap,
      });
      const child = assertDefined(
        result.subAgents['explore'],
        'The ordinary read tool keeps the child available'
      );
      const tools = await child.getToolsForExecution({});
      expect(tools).toHaveProperty('brainstrike_readWorkspaceFile');
      for (const toolId of ['brainstrike_askUser', 'brainstrike_submitPlan']) {
        if (capability === 'complete-host') {
          expect(tools).toHaveProperty(toolId);
        } else {
          expect(tools).not.toHaveProperty(toolId);
        }
      }
    }
  );

  it('re-asserts read-only and THROWS on an injected edit tool even when no permission snapshot gates it (defense-in-depth)', async () => {
    // The dangerous case: with `enforce:false` (the user opted out of the
    // permission gate) the snapshot is undefined and the gate is passthrough —
    // so a hostile persona naming a mutation tool would otherwise KEEP it.
    // `assertReadOnlyPersona` in the factory loop re-asserts the invariant
    // before any child agent is built, so the write tool never survives.
    const hostilePersona: AssistantPersonaDefinition = {
      ...explorePersona,
      allowedToolIds: ['brainstrike.grepSearch', 'brainstrike.writeWorkspaceFile'],
    };
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    await expect(
      buildPersonaSubAgents({
        guardedTools,
        languageModel: fakeModel,
        logger: noopLogger,
        permissionSnapshot: undefined,
        personas: [hostilePersona],
        provider: 'openai',
        resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
        toolNameMap,
      })
    ).rejects.toThrow(PersonaToolRiskViolationError);
  });

  it('passes candidate map through unchanged when no permission snapshot is threaded', async () => {
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    const result = await buildPersonaSubAgents({
      guardedTools,
      languageModel: fakeModel,
      logger: noopLogger,
      permissionSnapshot: undefined,
      personas: [explorePersona],
      provider: 'openai',
      resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
      toolNameMap,
    });
    const keys = await childToolKeys(
      assertDefined(result.subAgents['explore'], 'Expected explore subagent')
    );
    expect(keys).toHaveLength(5);
  });

  it('skips a persona tool that is not present in the run registry (no error)', async () => {
    // grepSearch is absent from the guarded map for this run.
    const { guardedTools, toolNameMap } = makeGuardedTools([
      'brainstrike.queryEmbeddingSpace',
      'brainstrike.globWorkspace',
      'brainstrike.readWorkspaceFile',
      'brainstrike.readWorkspaceDirectory',
    ]);
    const result = await buildPersonaSubAgents({
      guardedTools,
      languageModel: fakeModel,
      logger: noopLogger,
      permissionSnapshot: readAllowSnapshot,
      personas: [explorePersona],
      provider: 'openai',
      resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
      toolNameMap,
    });
    const keys = await childToolKeys(
      assertDefined(result.subAgents['explore'], 'Expected explore subagent')
    );
    expect(keys).not.toContain('brainstrike_grepSearch');
    expect(keys).toHaveLength(4);
  });

  it('builds a pinned persona with the resolver-provided model', async () => {
    const pinned: AssistantPersonaDefinition = {
      ...explorePersona,
      id: 'cheap-explore',
      model: { modelId: 'claude-haiku-4-5', provider: 'anthropic' },
    };
    const pinnedModel: LanguageModelV2 = { ...fakeModel, modelId: 'pinned-fake' };
    const resolvedPins: unknown[] = [];
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    const result = await buildPersonaSubAgents({
      guardedTools,
      languageModel: fakeModel,
      logger: noopLogger,
      permissionSnapshot: readAllowSnapshot,
      personas: [pinned],
      provider: 'openai',
      resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
      resolvePinnedModel: (persona) => {
        resolvedPins.push(persona.model);
        return pinnedModel;
      },
      toolNameMap,
    });

    const child = assertDefined(result.subAgents['cheap-explore'], 'Expected pinned subagent');
    expect(resolvedPins).toEqual([{ modelId: 'claude-haiku-4-5', provider: 'anthropic' }]);
    const model = await child.getModel();
    expect(model.modelId).toBe('pinned-fake');
  });

  it('does not invoke the resolver for un-pinned personas (parent model reuse)', async () => {
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    let resolverCalls = 0;
    const result = await buildPersonaSubAgents({
      guardedTools,
      languageModel: fakeModel,
      logger: noopLogger,
      permissionSnapshot: readAllowSnapshot,
      personas: [explorePersona],
      provider: 'openai',
      resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
      resolvePinnedModel: () => {
        resolverCalls += 1;
        return fakeModel;
      },
      toolNameMap,
    });
    expect(resolverCalls).toBe(0);
    const model = await assertDefined(
      result.subAgents['explore'],
      'Expected explore subagent'
    ).getModel();
    expect(model.modelId).toBe('fake');
  });

  it('skips a pinned persona whose resolution throws — with a warn, never a parent-model fallback', async () => {
    const pinned: AssistantPersonaDefinition = {
      ...explorePersona,
      id: 'broken-pin',
      model: { modelId: 'm', provider: 'anthropic' },
    };
    const warns: string[] = [];
    const logger: PermissionToolGateLogger = {
      info: () => undefined,
      warn: (_message, context) => {
        warns.push(String((context as { code?: string } | undefined)?.code));
      },
    };
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    const result = await buildPersonaSubAgents({
      guardedTools,
      languageModel: fakeModel,
      logger,
      permissionSnapshot: readAllowSnapshot,
      personas: [pinned, explorePersona],
      provider: 'openai',
      resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
      resolvePinnedModel: () => {
        throw new Error('missing_api_key');
      },
      toolNameMap,
    });
    expect(result.subAgents['broken-pin']).toBeUndefined();
    expect(result.delegationToolPersonas.has('agent-broken-pin')).toBe(false);
    expect(warns).toContain('subagent_persona_pin_unresolvable');
    // The failure is isolated: the healthy persona still registers.
    expect(result.subAgents['explore']).toBeDefined();
  });

  it('skips a pinned persona when no resolver is threaded (never runs on the parent model)', async () => {
    const pinned: AssistantPersonaDefinition = {
      ...explorePersona,
      id: 'pinned-no-resolver',
      model: { modelId: 'm', provider: 'anthropic' },
    };
    const warns: string[] = [];
    const logger: PermissionToolGateLogger = {
      info: () => undefined,
      warn: (_message, context) => {
        warns.push(String((context as { code?: string } | undefined)?.code));
      },
    };
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    const result = await buildPersonaSubAgents({
      guardedTools,
      languageModel: fakeModel,
      logger,
      permissionSnapshot: readAllowSnapshot,
      personas: [pinned],
      provider: 'openai',
      resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
      toolNameMap,
    });
    expect(result.subAgents['pinned-no-resolver']).toBeUndefined();
    expect(warns).toContain('subagent_persona_pin_unresolvable');
  });

  describe('resolves a reused projector budget at each parent or persona call', () => {
    // A domain-specific projector that fits its OWN output to the active
    // budget, matching desktop's construction-time fallback plus per-call
    // active-context behavior. This catches the producer/consumer mismatch;
    // an identity projector would exercise only the outer assertion.
    // A real, registered read-risk native tool id: `assertReadOnlyPersona`
    // resolves risk against the native tool registry, so a made-up id would
    // throw `PersonaToolRiskViolationError` before budget resolution ever runs.
    const domainToolId = 'brainstrike.grepSearch';
    const domainSanitizedId = 'brainstrike_grepSearch';
    function makeDomainPersona(model?: { modelId: string; provider: string }) {
      return {
        allowedToolIds: [domainToolId],
        description: 'Domain persona',
        id: 'domain-persona',
        instructions: 'Domain.',
        label: 'Domain',
        maxSteps: 4,
        ...(model ? { model } : {}),
      } satisfies AssistantPersonaDefinition;
    }
    function makeDomainGuardedTools(capturedParentBudget: ScaledToolResultBudget) {
      const guardedTools: ToolsInput = {
        [domainSanitizedId]: createTool({
          description: 'domain tool',
          execute: () => Promise.resolve('unused'),
          id: domainSanitizedId,
          inputSchema: z.object({}),
          toModelOutput: (output: unknown) => {
            const activeBudget =
              getActiveToolResultBudget()?.domainModelResultCharBudget ??
              capturedParentBudget.domainModelResultCharBudget;
            return {
              type: 'text',
              value: String(output).slice(0, Math.max(0, activeBudget - 26)),
            };
          },
        }),
      };
      const toolNameMap = new Map([[domainSanitizedId, domainToolId]]);
      return { guardedTools, toolNameMap };
    }
    const ceilingRawValue = 'x'.repeat(12_000);

    function invokeDomainToolModelOutput(tools: ToolsInput): { type: 'text'; value: string } {
      const tool = assertDefined(
        (tools as Record<string, { toModelOutput?: (output: unknown) => unknown }>)[
          domainSanitizedId
        ],
        'Expected domain tool'
      );
      const toModelOutput = assertDefined(
        tool.toModelOutput,
        'Expected the domain tool to carry a wrapped toModelOutput'
      );
      const projection = toModelOutput(ceilingRawValue);
      if (
        !projection ||
        typeof projection !== 'object' ||
        (projection as { type?: unknown }).type !== 'text' ||
        typeof (projection as { value?: unknown }).value !== 'string'
      ) {
        throw new TypeError('Expected a text domain projection');
      }
      return projection as { type: 'text'; value: string };
    }

    async function invokeChildDomainToolModelOutput(
      agent: Agent
    ): Promise<{ type: 'text'; value: string }> {
      const tools = (await agent.getToolsForExecution({})) as unknown as Record<
        string,
        { toModelOutput?: (output: unknown) => unknown }
      >;
      return invokeDomainToolModelOutput(tools as unknown as ToolsInput);
    }

    it('fits a pinned small-window child producer to the child budget, not its large parent', async () => {
      const largeParentBudget = resolveScaledToolResultBudget(1_050_000); // gpt-5.6-sol, ceiling tier
      const { guardedTools, toolNameMap } = makeDomainGuardedTools(largeParentBudget);
      const result = await buildPersonaSubAgents({
        guardedTools,
        languageModel: fakeModel,
        logger: noopLogger,
        permissionSnapshot: readAllowSnapshot,
        personas: [makeDomainPersona({ modelId: GEMMA4_E2B_MODEL_ID, provider: 'local' })],
        provider: 'openai',
        resolvedToolResultBudget: largeParentBudget,
        resolvePinnedModel: () => fakeModel,
        toolNameMap,
      });
      const child = assertDefined(
        result.subAgents['domain-persona'],
        'Expected domain-persona subagent'
      );
      const projection = await invokeChildDomainToolModelOutput(child);

      expect(decodedTextModelOutputChars(projection.value)).toBe(2000);
    });

    it('lets a pinned large-window child producer widen beyond its small parent budget', async () => {
      const smallParentBudget = resolveScaledToolResultBudget(8192); // floor tier
      const { guardedTools, toolNameMap } = makeDomainGuardedTools(smallParentBudget);
      const pinnedLargeModel: LanguageModelV2 = { ...fakeModel, modelId: 'pinned-large' };
      const result = await buildPersonaSubAgents({
        guardedTools,
        languageModel: fakeModel,
        logger: noopLogger,
        permissionSnapshot: readAllowSnapshot,
        personas: [makeDomainPersona({ modelId: 'gpt-5.6-sol', provider: 'openai' })],
        provider: 'openai',
        resolvedToolResultBudget: smallParentBudget,
        resolvePinnedModel: () => pinnedLargeModel,
        toolNameMap,
      });
      const child = assertDefined(
        result.subAgents['domain-persona'],
        'Expected domain-persona subagent'
      );
      const projection = await invokeChildDomainToolModelOutput(child);

      expect(decodedTextModelOutputChars(projection.value)).toBe(12_000);
    });

    it('keeps an un-pinned persona on the parent exact resolved budget', async () => {
      const parentBudget = resolveScaledToolResultBudget(131_072); // anchor tier
      const { guardedTools, toolNameMap } = makeDomainGuardedTools(parentBudget);
      const result = await buildPersonaSubAgents({
        guardedTools,
        languageModel: fakeModel,
        logger: noopLogger,
        permissionSnapshot: readAllowSnapshot,
        personas: [makeDomainPersona()],
        provider: 'openai',
        resolvedToolResultBudget: parentBudget,
        toolNameMap,
      });
      const child = assertDefined(
        result.subAgents['domain-persona'],
        'Expected domain-persona subagent'
      );
      const projection = await invokeChildDomainToolModelOutput(child);

      expect(decodedTextModelOutputChars(projection.value)).toBe(
        parentBudget.domainModelResultCharBudget
      );
    });

    it('keeps a parent projection on the parent exact resolved budget', () => {
      const parentBudget = resolveScaledToolResultBudget(8192); // floor tier
      const { guardedTools, toolNameMap } = makeDomainGuardedTools(parentBudget);
      const projectedParentTools = applyToolModelOutputProjections(
        guardedTools,
        toolNameMap,
        undefined,
        parentBudget
      );

      const projection = invokeDomainToolModelOutput(projectedParentTools);

      expect(decodedTextModelOutputChars(projection.value)).toBe(
        parentBudget.domainModelResultCharBudget
      );
    });
  });
});
