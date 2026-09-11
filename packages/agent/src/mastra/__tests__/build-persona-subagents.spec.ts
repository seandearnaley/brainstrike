import { GEMMA4_E2B_MODEL_ID } from '@brainstrike/assistant-contract/local-llm';
import {
  type AssistantPersonaDefinition,
  PersonaToolRiskViolationError,
} from '@brainstrike/assistant-contract/personas';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import { buildNativeToolRiskMap } from '@brainstrike/assistant-contract/tool-metadata';
import type { Agent, ToolsInput } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  decodedTextModelOutputChars,
  resolveScaledToolResultBudget,
  type ScaledToolResultBudget,
} from '../../stream/tool-output-limits';
import { buildPersonaSubAgents } from '../build-persona-subagents';
import { createDelegatedConversationBinding } from '../delegated-conversation-binding';
import type { PermissionToolGateLogger } from '../permission-tool-gate';
import { applyToolModelOutputProjections, getActiveToolResultBudget } from '../tool-model-output';

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

describe('buildPersonaSubAgents', () => {
  it('builds an explore child with exactly its 5 gated tools, no agents, no memory (read:allow)', async () => {
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    const result = buildPersonaSubAgents({
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
    expect(result.personasById.get('explore')).toBe(explorePersona);
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
    const result = buildPersonaSubAgents({
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

  it('registers no subagent when the policy gates every persona tool to ask (read:ask)', () => {
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    const result = buildPersonaSubAgents({
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
    const options = {
      conversationBinding,
      guardedTools,
      hasStorage: true,
      languageModel: fakeModel,
      logger: noopLogger,
      permissionSnapshot: readAskSnapshot,
      personas: [explorePersona],
      provider: 'openai',
      resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
      toolNameMap,
    };
    const child = assertDefined(
      buildPersonaSubAgents(options).subAgents['explore'],
      'Expected resumable read-only child'
    );
    const tools = await child.getToolsForExecution({});
    expect(Object.keys(tools)).toHaveLength(5);
    for (const tool of Object.values(tools)) {
      expect(tool).toHaveProperty('requireApproval', true);
    }
    expect(
      buildPersonaSubAgents({ ...options, hasStorage: false }).subAgents['explore']
    ).toBeUndefined();
    expect(
      buildPersonaSubAgents({
        ...options,
        conversationBinding: createDelegatedConversationBinding(async () => undefined),
      }).subAgents['explore']
    ).toBeUndefined();
  });

  it('re-asserts read-only and THROWS on an injected edit tool even when no permission snapshot gates it (defense-in-depth)', () => {
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
    expect(() =>
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
    ).toThrow(PersonaToolRiskViolationError);
  });

  it('passes candidate map through unchanged when no permission snapshot is threaded', async () => {
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    const result = buildPersonaSubAgents({
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
    const result = buildPersonaSubAgents({
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
    const result = buildPersonaSubAgents({
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
    const result = buildPersonaSubAgents({
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

  it('skips a pinned persona whose resolution throws — with a warn, never a parent-model fallback', () => {
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
    const result = buildPersonaSubAgents({
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

  it('skips a pinned persona when no resolver is threaded (never runs on the parent model)', () => {
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
    const result = buildPersonaSubAgents({
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
      const result = buildPersonaSubAgents({
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
      const result = buildPersonaSubAgents({
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
      const result = buildPersonaSubAgents({
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
