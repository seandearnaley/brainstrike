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
import { buildPersonaSubAgents } from '../build-persona-subagents';
import type { PermissionToolGateLogger } from '../permission-tool-gate';

// Mastra vendors its own AI SDK v5 provider types (the workspace
// `@ai-sdk/provider` is a different major and is NOT assignable), so extract
// the v2 language-model member straight from the config union the factory
// accepts.
type LanguageModelV2 = Extract<MastraModelConfig, { specificationVersion: 'v2' }>;

const noopLogger: PermissionToolGateLogger = {
  info: () => undefined,
  warn: () => undefined,
};

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
      toolNameMap,
    });

    const child = assertDefined(result.subAgents['explore'], 'Expected explore subagent');
    expect(result.delegationToolPersonas.get('agent-explore')).toBe('explore');
    expect(result.personasById.get('explore')).toBe(explorePersona);
    expect(child.hasOwnMemory()).toBe(false);

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

  it('registers no subagent when the policy gates every persona tool to ask (read:ask)', () => {
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    const result = buildPersonaSubAgents({
      guardedTools,
      languageModel: fakeModel,
      logger: noopLogger,
      permissionSnapshot: readAskSnapshot,
      personas: [explorePersona],
      toolNameMap,
    });
    expect(result.subAgents['explore']).toBeUndefined();
    expect(result.delegationToolPersonas.size).toBe(0);
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
      toolNameMap,
    });
    expect(result.subAgents['pinned-no-resolver']).toBeUndefined();
    expect(warns).toContain('subagent_persona_pin_unresolvable');
  });
});
