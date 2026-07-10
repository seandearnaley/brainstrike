/**
 * Persona → child-`Agent` factory (subagent personas, T2).
 *
 * Builds Mastra supervisor "subagents" from persona DATA. Each returned child is
 * a plain `new Agent({...})` whose tool map is a permission-gated SUBSET of the
 * parent's already-guarded tool map — so per-tool timeout + structured
 * `GuardedToolError` inherit for free (D4). Children are constructed WITHOUT
 * `agents` (no nesting) and WITHOUT `memory` (Mastra injects the parent's memory
 * and scopes writes to a fresh delegation thread — D6/D7).
 *
 * Permission composition (D3): the persona's candidate map passes through the
 * SAME `filterToolsByPermissionWithMetadata` gate as the parent; every `'ask'`
 * tool is then OMITTED (fail-safe — no nested approval UX in v1). A persona whose
 * post-gate map is empty is NOT registered (no useless delegation tool).
 */

import {
  type AssistantPersonaDefinition,
  assertReadOnlyPersona,
} from '@brainstrike/assistant-contract/personas';
import { Agent, type ToolsInput } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import {
  filterToolsByPermissionWithMetadata,
  type PermissionToolGateLogger,
  type PermissionToolGateSnapshot,
} from './permission-tool-gate';

/**
 * Thrown when a persona pins a model in v1 (the seam exists but is not yet
 * wired). Explicit, not a silent no-op — the persona author gets a clear error.
 */
export class PersonaModelPinningNotImplementedError extends Error {
  readonly personaId: string;

  constructor(personaId: string) {
    super(
      `Persona '${personaId}' pins a model, but persona model pinning is not implemented in v1. ` +
        'Leave `model` undefined; children reuse the parent language model.'
    );
    this.name = 'PersonaModelPinningNotImplementedError';
    this.personaId = personaId;
  }
}

export interface PersonaSubAgentBuildResult {
  /** 'agent-<personaId>' → personaId, for the stream mapper (D9). */
  readonly delegationToolPersonas: ReadonlyMap<string, string>;
  /** Persona id → resolved persona (for delegation caps + instructions). */
  readonly personasById: ReadonlyMap<string, AssistantPersonaDefinition>;
  /** Persona id → constructed child Agent; keys of `agents` config are persona ids. */
  readonly subAgents: Record<string, Agent>;
}

export interface BuildPersonaSubAgentsParams {
  /** Parent's post-guard tool map (keyed by sanitized id). */
  readonly guardedTools: ToolsInput;
  /** Parent's resolved model instance (D5 — children reuse it). */
  readonly languageModel: MastraModelConfig;
  readonly logger: PermissionToolGateLogger;
  readonly permissionSnapshot: PermissionToolGateSnapshot | undefined;
  readonly personas: readonly AssistantPersonaDefinition[];
  /** sanitizedId → originalName (the parent's map). */
  readonly toolNameMap: ReadonlyMap<string, string>;
}

function buildOriginalToSanitized(
  toolNameMap: ReadonlyMap<string, string>
): ReadonlyMap<string, string> {
  const reverse = new Map<string, string>();
  for (const [sanitizedId, originalName] of toolNameMap) {
    reverse.set(originalName, sanitizedId);
  }
  return reverse;
}

/**
 * Select the persona's candidate tools from the parent's guarded map. A persona
 * tool id absent from the run's registry is SKIPPED-with-log (tool availability
 * is runtime-dependent, e.g. webSearch behind enabledNativeToolIds), never an
 * error.
 */
function selectCandidateTools(
  persona: AssistantPersonaDefinition,
  guardedTools: ToolsInput,
  originalToSanitized: ReadonlyMap<string, string>,
  logger: PermissionToolGateLogger
): { candidate: ToolsInput; candidateNameMap: Map<string, string> } {
  const candidate: Record<string, unknown> = {};
  const candidateNameMap = new Map<string, string>();
  for (const originalName of persona.allowedToolIds) {
    const sanitizedId = originalToSanitized.get(originalName);
    if (!(sanitizedId && sanitizedId in guardedTools)) {
      logger.info('Persona tool not available in this run; skipping', {
        code: 'subagent_persona_tool_missing',
        personaId: persona.id,
        tool: originalName,
      });
      continue;
    }
    candidate[sanitizedId] = (guardedTools as Record<string, unknown>)[sanitizedId];
    candidateNameMap.set(sanitizedId, originalName);
  }
  return { candidate: candidate as ToolsInput, candidateNameMap };
}

function buildChildInstructions(
  persona: AssistantPersonaDefinition,
  toolOriginalNames: readonly string[]
): string {
  if (toolOriginalNames.length === 0) {
    return persona.instructions;
  }
  return `${persona.instructions}\n\nAvailable tools: ${toolOriginalNames.join(', ')}.`;
}

/**
 * Build persona child Agents for the parent supervisor.
 *
 * @throws {PersonaModelPinningNotImplementedError} when a persona pins a model (D5).
 */
export function buildPersonaSubAgents(
  params: BuildPersonaSubAgentsParams
): PersonaSubAgentBuildResult {
  const originalToSanitized = buildOriginalToSanitized(params.toolNameMap);
  const subAgents: Record<string, Agent> = {};
  const delegationToolPersonas = new Map<string, string>();
  const personasById = new Map<string, AssistantPersonaDefinition>();

  for (const persona of params.personas) {
    // Defense-in-depth: re-assert the read-only invariant at build time. The
    // permission gate below is passthrough when `permissionSnapshot` is
    // undefined (the user's `enforce:false` opt-out), so a hostile persona
    // naming a mutation tool would otherwise keep it — this throws first.
    assertReadOnlyPersona(persona);

    if (persona.model) {
      throw new PersonaModelPinningNotImplementedError(persona.id);
    }

    const { candidate, candidateNameMap } = selectCandidateTools(
      persona,
      params.guardedTools,
      originalToSanitized,
      params.logger
    );

    // Same gate as the parent; then OMIT every ask tool (no nested approval UX).
    const gateResult = filterToolsByPermissionWithMetadata(
      candidate,
      params.permissionSnapshot,
      params.toolNameMap,
      params.logger
    );
    const childTools: Record<string, unknown> = {};
    const keptOriginalNames: string[] = [];
    for (const [sanitizedId, tool] of Object.entries(gateResult.tools)) {
      if (gateResult.askToolIds.has(sanitizedId)) {
        params.logger.info('Persona tool gated to ask; omitting from subagent (fail-safe)', {
          code: 'subagent_ask_tool_omitted',
          personaId: persona.id,
          sanitizedId,
          tool: candidateNameMap.get(sanitizedId) ?? sanitizedId,
        });
        continue;
      }
      childTools[sanitizedId] = tool;
      keptOriginalNames.push(candidateNameMap.get(sanitizedId) ?? sanitizedId);
    }

    if (keptOriginalNames.length === 0) {
      params.logger.info('Persona has no available tools after gating; not registering', {
        code: 'subagent_persona_empty_toolset',
        personaId: persona.id,
      });
      continue;
    }

    // The child agent id MUST equal the persona id: Mastra sets
    // `DelegationStartContext.primitiveId = agent.id`, and the delegation caps
    // (subagent-delegation.ts) resolve the persona by that id.
    subAgents[persona.id] = new Agent({
      description: persona.description,
      id: persona.id,
      instructions: buildChildInstructions(persona, keptOriginalNames),
      model: params.languageModel,
      name: persona.label,
      tools: childTools as ToolsInput,
    });
    delegationToolPersonas.set(`agent-${persona.id}`, persona.id);
    personasById.set(persona.id, persona);
  }

  return { delegationToolPersonas, personasById, subAgents };
}
