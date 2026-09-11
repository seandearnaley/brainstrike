/**
 * Persona subagent assembly for the Mastra agent runtime (BST-742): builds the
 * delegation parts (child Agents + instruction summaries) `createMastraAgentRuntime`
 * feeds to the supervisor Agent. See docs/agents/assistant-subagents.md for the
 * delegation contract.
 */
import {
  type AssistantPersonaDefinition,
  delegationDescriptionForPersona,
} from '@brainstrike/assistant-contract/personas';
import { createLogger } from '@brainstrike/logging';
import type { Agent, ToolsInput } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { MastraMemory } from '@mastra/core/memory';
import type { InputProcessor, OutputProcessor } from '@mastra/core/processors';
import type { ScaledToolResultBudget } from '../../stream/tool-output-limits';
import type { RuntimeData } from '../../types';
import { buildPersonaSubAgents, type DelegatedExecutionOptions } from '../build-persona-subagents';
import type { DelegationPersonaSummary } from '../default-instructions';
import type { DelegatedConversationBinding } from '../delegated-conversation-binding';
import type { DelegatedSystemContextSource } from '../delegated-system-context';
import type { PermissionToolGateSnapshot } from '../permission-tool-gate';
import { shouldEnablePersonas } from '../subagent-delegation';
import type { ModelOutputProjectionObserver } from '../tool-model-output';

const logger = createLogger('MastraAgent');

export interface PersonaRuntimeParts {
  artifactReaderDelegationTools: readonly string[];
  delegationToolPersonas: ReadonlyMap<string, string>;
  hasSubAgents: boolean;
  instructionPersonaSummaries: DelegationPersonaSummary[] | undefined;
  personasById: ReadonlyMap<string, AssistantPersonaDefinition>;
  subAgents: Record<string, Agent>;
}

const EMPTY_PERSONA_RUNTIME_PARTS: PersonaRuntimeParts = {
  artifactReaderDelegationTools: [],
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
 * (pre-permission-filter) and retain ask tools only with native storage and durable child control.
 *
 * `guardedTools` is the RAW (pre-model-output-projection) map: model-output
 * projection is applied per-child in `buildPersonaSubAgents`, since a persona
 * that pins its own model must project against THAT model's resolved budget
 * (BST-1206 review), not the parent's — reusing an already-projected parent
 * map here would bake the wrong budget into every pinned persona's tools.
 */
export async function resolvePersonaRuntimeParts(params: {
  delegatedExecutionOptions?: DelegatedExecutionOptions;
  conversationBinding?: DelegatedConversationBinding | undefined;
  guardedTools: ToolsInput;
  getDelegatedSystemContext?: DelegatedSystemContextSource | undefined;
  hasStorage?: boolean;
  modelName: string;
  memory?: MastraMemory | undefined;
  hydrateToolDiscoveryFromMemory?: boolean | undefined;
  rootMemoryContext?: RuntimeData['memory'];
  localToolIds: ReadonlySet<string>;
  workspaceSkills?: RuntimeData['workspaceSkills'];
  languageModel: MastraModelConfig;
  permissionSnapshot: PermissionToolGateSnapshot | undefined;
  personas: readonly AssistantPersonaDefinition[] | undefined;
  planModeActive: boolean;
  provider: string;
  resolvedToolResultBudget: ScaledToolResultBudget;
  resolvePinnedModel: (persona: AssistantPersonaDefinition) => MastraModelConfig;
  settleChildToolOutputs?: (tools: ToolsInput, budget: ScaledToolResultBudget) => ToolsInput;
  toolNameMap: Map<string, string>;
  toolOutputObserver?: ModelOutputProjectionObserver;
  turnPersistenceProcessor?: (InputProcessor & OutputProcessor) | undefined;
}): Promise<PersonaRuntimeParts> {
  if (params.planModeActive || !shouldEnablePersonas(params.provider, params.personas)) {
    return EMPTY_PERSONA_RUNTIME_PARTS;
  }
  const personaBuild = await buildPersonaSubAgents({
    delegatedExecutionOptions: params.delegatedExecutionOptions,
    memory: params.memory,
    ...(params.conversationBinding ? { conversationBinding: params.conversationBinding } : {}),
    ...(params.settleChildToolOutputs
      ? { settleChildToolOutputs: params.settleChildToolOutputs }
      : {}),
    guardedTools: params.guardedTools,
    ...(params.getDelegatedSystemContext
      ? { getDelegatedSystemContext: params.getDelegatedSystemContext }
      : {}),
    localToolIds: params.localToolIds,
    modelName: params.modelName,
    resumeMemory: params.hydrateToolDiscoveryFromMemory ? params.memory : undefined,
    rootMemoryContext: params.rootMemoryContext,
    ...(params.workspaceSkills ? { workspaceSkills: params.workspaceSkills } : {}),
    hasStorage: Boolean(params.hasStorage),
    languageModel: params.languageModel,
    logger,
    permissionSnapshot: params.permissionSnapshot,
    personas: params.personas ?? [],
    provider: params.provider,
    resolvedToolResultBudget: params.resolvedToolResultBudget,
    resolvePinnedModel: params.resolvePinnedModel,
    toolNameMap: params.toolNameMap,
    turnPersistenceProcessor: params.turnPersistenceProcessor,
    ...(params.toolOutputObserver ? { toolOutputObserver: params.toolOutputObserver } : {}),
  });
  return {
    artifactReaderDelegationTools: personaBuild.artifactReaderDelegationTools,
    delegationToolPersonas: personaBuild.delegationToolPersonas,
    hasSubAgents: Object.keys(personaBuild.subAgents).length > 0,
    instructionPersonaSummaries: Array.from(personaBuild.personasById.values(), (persona) => ({
      description: delegationDescriptionForPersona(persona),
      id: persona.id,
      label: persona.label,
    })),
    personasById: personaBuild.personasById,
    subAgents: personaBuild.subAgents,
  };
}
