/**
 * Persona subagent assembly for the Mastra agent runtime (BST-742): builds the
 * delegation parts (child Agents + instruction summaries) `createMastraAgentRuntime`
 * feeds to the supervisor Agent. See docs/agents/assistant-subagents.md for the
 * delegation contract.
 */
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { createLogger } from '@brainstrike/utils';
import type { Agent, ToolsInput } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { buildPersonaSubAgents } from '../build-persona-subagents';
import type { DelegationPersonaSummary } from '../default-instructions';
import type { PermissionToolGateSnapshot } from '../permission-tool-gate';
import { shouldEnablePersonas } from '../subagent-delegation';

const logger = createLogger('MastraAgent');

export interface PersonaRuntimeParts {
  delegationToolPersonas: ReadonlyMap<string, string>;
  hasSubAgents: boolean;
  instructionPersonaSummaries: DelegationPersonaSummary[] | undefined;
  personasById: ReadonlyMap<string, AssistantPersonaDefinition>;
  subAgents: Record<string, Agent>;
}

const EMPTY_PERSONA_RUNTIME_PARTS: PersonaRuntimeParts = {
  delegationToolPersonas: new Map(),
  hasSubAgents: false,
  instructionPersonaSummaries: undefined,
  personasById: new Map(),
  subAgents: {},
};

/**
 * Build the persona delegation parts (child Agents + summaries) for a run.
 * Skipped for the built-in local provider (prompt budget) and in plan mode
 * (delegation is out of scope for planning — the `agent-<id>` tools are
 * Mastra-constructed and never enter the plan-mode-filtered tool map, so we
 * simply do not pass `agents`). Children re-gate the parent's GUARDED tool map
 * (pre-permission-filter) so ask tools are omitted per the child's own gate.
 */
export function resolvePersonaRuntimeParts(params: {
  guardedTools: ToolsInput;
  languageModel: MastraModelConfig;
  permissionSnapshot: PermissionToolGateSnapshot | undefined;
  personas: readonly AssistantPersonaDefinition[] | undefined;
  planModeActive: boolean;
  provider: string;
  resolvePinnedModel: (persona: AssistantPersonaDefinition) => MastraModelConfig;
  toolNameMap: Map<string, string>;
}): PersonaRuntimeParts {
  if (params.planModeActive || !shouldEnablePersonas(params.provider, params.personas)) {
    return EMPTY_PERSONA_RUNTIME_PARTS;
  }
  const personaBuild = buildPersonaSubAgents({
    guardedTools: params.guardedTools,
    languageModel: params.languageModel,
    logger,
    permissionSnapshot: params.permissionSnapshot,
    personas: params.personas ?? [],
    resolvePinnedModel: params.resolvePinnedModel,
    toolNameMap: params.toolNameMap,
  });
  return {
    delegationToolPersonas: personaBuild.delegationToolPersonas,
    hasSubAgents: Object.keys(personaBuild.subAgents).length > 0,
    instructionPersonaSummaries: Array.from(personaBuild.personasById.values(), (persona) => ({
      description: persona.description,
      id: persona.id,
      label: persona.label,
    })),
    personasById: personaBuild.personasById,
    subAgents: personaBuild.subAgents,
  };
}
