import { BUILT_IN_PERSONAS } from '@brainstrike/assistant-contract/personas';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import { buildNativeToolRiskMap } from '@brainstrike/assistant-contract/tool-metadata';
import type { Agent, ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createListingOnlyModel } from '../../providers/listing-only-model';
import { resolveToolResultBudgetForModel } from '../../stream/tool-output-limits';
import { buildPersonaSubAgents } from '../build-persona-subagents';
import { createDelegatedConversationBinding } from '../delegated-conversation-binding';
import { sanitizeToolName } from '../tool-sanitizer';

const TOOL_IDS = [
  'brainstrike.globWorkspace',
  'brainstrike.grepSearch',
  'brainstrike.queryEmbeddingSpace',
  'brainstrike.readToolOutputArtifact',
  'brainstrike.readWorkspaceDirectory',
  'brainstrike.readWorkspaceFile',
  'brainstrike.writeWorkspaceFile',
];

function persona(id: 'explore' | 'worker') {
  const found = BUILT_IN_PERSONAS.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`Built-in ${id} persona is missing`);
  }
  return found;
}

async function childToolKeys(child: Agent): Promise<string[]> {
  return Object.keys(await child.getToolsForExecution({}));
}

// 2026-09-14 (thread-f6be9761): read-only Explorer children delegated to more
// Explorers three levels deep, consumed all eight invocations of the turn and
// starved the root's own specialists. The contract has always said read-only
// children cannot delegate; recursion is a worker capability.
describe('persona recursion gate', () => {
  it.for([
    { expectAgents: false, persona: 'explore' },
    { expectAgents: true, persona: 'worker' },
  ] as const)(
    'with durable budgets only a worker child may delegate (%j)',
    async ({ expectAgents, persona: personaId }) => {
      const toolNameMap = new Map<string, string>();
      const guardedTools: ToolsInput = {};
      for (const id of TOOL_IDS) {
        const sanitized = sanitizeToolName(id);
        toolNameMap.set(sanitized, id);
        guardedTools[sanitized] = createTool({
          description: id,
          execute: async () => ({ ok: true }),
          id,
          inputSchema: z.object({}),
        });
      }
      const result = await buildPersonaSubAgents({
        conversationBinding: {
          ...createDelegatedConversationBinding(async () => undefined),
          bindRun: async () => ({ threadId: 'child' }),
          budget: {
            admitInvocation: async () => ({ admitted: true as const }),
            readTurnLimits: async () => undefined,
            reserveStep: async () => ({ id: 'unused', outputTokens: 8192, synthesis: false }),
            settleStep: async () => undefined,
          },
          claimToolAction: async () => undefined,
          finishToolActions: async () => undefined,
          prepareToolAction: async () => undefined,
          releaseUnexecutedToolAction: async () => undefined,
          resolveToolAction: async () => [],
        },
        delegatedExecutionOptions: {},
        guardedTools,
        hasStorage: true,
        languageModel: createListingOnlyModel(),
        localToolIds: new Set(TOOL_IDS.map(sanitizeToolName)),
        logger: { info() {}, warn() {} },
        modelName: 'gpt-5.6-sol',
        permissionSnapshot: {
          policies: { edit: 'allow', execute: 'allow', mcp: 'allow', read: 'allow' },
          riskByTool: buildNativeToolRiskMap(),
          yolo: false,
        },
        personas: [persona(personaId)],
        provider: 'openai',
        resolvedToolResultBudget: resolveToolResultBudgetForModel('openai', 'gpt-5.6-sol'),
        subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
        toolNameMap,
      });
      const child = result.subAgents[personaId];
      if (!child) {
        throw new Error(`Expected ${personaId} child`);
      }
      expect((await childToolKeys(child)).some((key) => key.startsWith('agent-'))).toBe(
        expectAgents
      );
    }
  );
});
