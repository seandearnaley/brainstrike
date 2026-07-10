import type { LanguageModelV2 } from '@ai-sdk/provider';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import { buildNativeToolRiskMap } from '@brainstrike/assistant-contract/tool-metadata';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildPersonaSubAgents,
  PersonaModelPinningNotImplementedError,
} from '../build-persona-subagents';
import type { PermissionToolGateLogger } from '../permission-tool-gate';

const noopLogger: PermissionToolGateLogger = {
  info: () => undefined,
  warn: () => undefined,
};

// A minimal valid LanguageModelV2 so the child Agent can resolve its model
// config when we inspect its tools; buildPersonaSubAgents never invokes it.
const fakeModel: LanguageModelV2 = {
  doGenerate: () => Promise.reject(new Error('unused in this test')),
  doStream: () => Promise.reject(new Error('unused in this test')),
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
  const guardedTools: Record<string, unknown> = {};
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

async function childToolKeys(agent: {
  getToolsForExecution: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
}): Promise<string[]> {
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

    const child = result.subAgents.explore;
    expect(child).toBeDefined();
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
    expect(result.subAgents.explore).toBeUndefined();
    expect(result.delegationToolPersonas.size).toBe(0);
  });

  it('the gate omits an injected edit tool even if it bypassed contract validation (deny)', async () => {
    const hostilePersona: AssistantPersonaDefinition = {
      ...explorePersona,
      allowedToolIds: ['brainstrike.grepSearch', 'brainstrike.writeWorkspaceFile'],
    };
    const denySnapshot: PermissionToolGateSnapshot = {
      defaultRisk: 'mcp',
      policies: { edit: 'deny', execute: 'deny', mcp: 'allow', read: 'allow' },
      riskByTool: buildNativeToolRiskMap(),
      yolo: false,
    };
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    const result = buildPersonaSubAgents({
      guardedTools,
      languageModel: fakeModel,
      logger: noopLogger,
      permissionSnapshot: denySnapshot,
      personas: [hostilePersona],
      toolNameMap,
    });
    const keys = await childToolKeys(result.subAgents.explore);
    expect(keys).toEqual(['brainstrike_grepSearch']);
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
    const keys = await childToolKeys(result.subAgents.explore);
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
    const keys = await childToolKeys(result.subAgents.explore);
    expect(keys).not.toContain('brainstrike_grepSearch');
    expect(keys).toHaveLength(4);
  });

  it('throws PersonaModelPinningNotImplementedError when a persona pins a model', () => {
    const pinned: AssistantPersonaDefinition = {
      ...explorePersona,
      model: { modelId: 'gpt-4o-mini', provider: 'openai' },
    };
    const { guardedTools, toolNameMap } = makeGuardedTools(ALL_TOOL_IDS);
    expect(() =>
      buildPersonaSubAgents({
        guardedTools,
        languageModel: fakeModel,
        logger: noopLogger,
        permissionSnapshot: readAllowSnapshot,
        personas: [pinned],
        toolNameMap,
      })
    ).toThrow(PersonaModelPinningNotImplementedError);
  });
});
