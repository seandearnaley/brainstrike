/**
 * The child approval gate (settled 2026-09-15, SESSION GRANT STOPS ASKING):
 * every persona child carries its OWN live predicate — built from the ask
 * tools it actually kept and the leg's remembered grant — as Mastra's
 * `requireToolApproval` through `defaultOptions`. Split from
 * build-persona-subagents.spec.ts (per-file line cap).
 */

import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import {
  buildNativeToolRiskMap,
  type PermissionToolGateSnapshot,
} from '@brainstrike/assistant-contract/tool-metadata';
import type { ToolsInput } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveScaledToolResultBudget } from '../../stream/tool-output-limits';
import {
  hasToolResult,
  scriptedAgentModel,
  textParts,
  toolCallParts,
} from '../../test-fixtures/scripted-agent-model';
import { buildPersonaSubAgents } from '../build-persona-subagents';
import { createDelegatedConversationBinding } from '../delegated-conversation-binding';
import { createLiveDecisionChannel } from '../live-decision-channel';
import type { PermissionToolGateLogger } from '../../permissions/permission-tool-gate';

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

const fakeModel: LanguageModelV2 = {
  doGenerate: (): Promise<never> => Promise.reject(new Error('unused in this test')),
  doStream: (): Promise<never> => Promise.reject(new Error('unused in this test')),
  modelId: 'fake',
  provider: 'fake',
  specificationVersion: 'v2',
  supportedUrls: {},
};

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

describe('child approval gate (settled 2026-09-15: the predicate reaches every child call)', () => {
  const readAsk: PermissionToolGateSnapshot = {
    policies: { edit: 'deny', execute: 'deny', mcp: 'deny', read: 'ask' },
    riskByTool: buildNativeToolRiskMap(),
    yolo: false,
  };
  const readGrant: PermissionToolGateSnapshot = { ...readAsk, sessionGrants: ['read'] };

  async function buildChildWithGate(channel: ReturnType<typeof createLiveDecisionChannel>) {
    const model = scriptedAgentModel((options) =>
      hasToolResult(options, 'brainstrike_grepSearch')
        ? textParts('CHILD_DONE')
        : toolCallParts('brainstrike_grepSearch', 'child-read', { pattern: 'flag' })
    );
    // The complete durable host boundary: without it `canSuspendPersonaTools`
    // omits every ask tool and the persona is not registered at all.
    const binding = {
      ...createDelegatedConversationBinding(async () => undefined),
      bindRun: async () => ({ threadId: 'child' }),
      claimToolAction: async () => undefined,
      finishToolActions: async () => undefined,
      prepareToolAction: async () => undefined,
      releaseUnexecutedToolAction: async () => undefined,
      resolveToolAction: async () => [],
    };
    const result = await buildPersonaSubAgents({
      ...makeGuardedTools(ALL_TOOL_IDS),
      conversationBinding: binding,
      hasStorage: true,
      languageModel: model.model,
      liveDecisions: channel,
      logger: noopLogger,
      permissionSnapshot: readAsk,
      personas: [explorePersona],
      provider: 'openai',
      resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    return { child: assertDefined(result.subAgents['explore'], 'Child missing'), model };
  }

  /** The converted core tool Mastra executes: the function-form flag became `needsApprovalFn`. */
  async function coreTool(
    child: Awaited<ReturnType<typeof buildChildWithGate>>['child'],
    name: string
  ) {
    const tools = await child.getToolsForExecution({});
    const tool = tools[name] as
      | { requireApproval?: unknown; needsApprovalFn?: (input: unknown, ctx: unknown) => unknown }
      | undefined;
    return assertDefined(tool, `${name} missing`);
  }

  it("carries the child's OWN ask set as a per-tool FUNCTION flag Mastra evaluates per call, and no run-wide predicate", async () => {
    const channel = createLiveDecisionChannel();
    const { child } = await buildChildWithGate(channel);
    // No run-wide predicate: Mastra's per-step concurrency classification
    // stays exactly what the per-tool flag gave it (agent-DsRUDsS_.js:24054).
    expect((await child.getDefaultOptions({})).requireToolApproval).toBeUndefined();
    // Under `read: 'ask'` every Explorer tool is an ask tool: each kept tool
    // carries the flag and its own per-call check.
    const tools = Object.keys(await child.getToolsForExecution({}));
    expect(tools).toHaveLength(5);
    for (const name of tools) {
      const tool = await coreTool(child, name);
      expect(tool.requireApproval).toBe(true);
      expect(typeof tool.needsApprovalFn).toBe('function');
      expect(await tool.needsApprovalFn?.({}, {})).toBe(true);
    }
  });

  it('lifts the child gate the moment the leg remembers a session grant — on the very next call, mid-stream', async () => {
    // MUTATION: a child gate built from the ROOT's ask set, or a flag captured
    // at clone time, keeps returning true here.
    const channel = createLiveDecisionChannel();
    const { child } = await buildChildWithGate(channel);
    const grep = await coreTool(child, 'brainstrike_grepSearch');
    expect(await grep.needsApprovalFn?.({}, {})).toBe(true);
    channel.remember(readGrant);
    expect(await grep.needsApprovalFn?.({}, {})).toBe(false);
  });

  it('gives a child with no ask tools no flag at all (parallel tool calls stay parallel)', async () => {
    const result = await buildPersonaSubAgents({
      ...makeGuardedTools(ALL_TOOL_IDS),
      languageModel: fakeModel,
      liveDecisions: createLiveDecisionChannel(),
      logger: noopLogger,
      permissionSnapshot: readAllowSnapshot,
      personas: [explorePersona],
      provider: 'openai',
      resolvedToolResultBudget: ANCHOR_TOOL_RESULT_BUDGET,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    const child = assertDefined(result.subAgents['explore'], 'Child missing');
    expect((await child.getDefaultOptions({})).requireToolApproval).toBeUndefined();
    for (const tool of Object.values(await child.getToolsForExecution({}))) {
      expect((tool as { requireApproval?: unknown }).requireApproval).toBeFalsy();
    }
  });
});
