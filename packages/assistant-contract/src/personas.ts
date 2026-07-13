/**
 * Assistant personas (subagent delegation targets).
 *
 * A persona is DATA: a named, read-only child agent the supervisor can delegate
 * to. Mastra converts each persona registered under the parent's `agents` config
 * into an `agent-<id>` tool (see docs/agents/assistant-subagents.md). This module owns only the
 * contract shape + the read-only invariant; the agent package builds the child
 * `Agent`s and the desktop server threads `BUILT_IN_PERSONAS` server-side.
 *
 * The read-only invariant is enforced at module init (construction-time): every
 * built-in persona's `allowedToolIds` must resolve to risk `'read'` via the same
 * registry the permission gate uses. An unknown id is NOT read — it throws.
 */

import { NATIVE_TOOL_DEFAULTS, WEB_SEARCH_TOOL_ID } from './tool-categories.js';
import { resolveToolRiskCategory, type ToolRiskCategory } from './tool-risk.js';

/** Ids of the personas that ship with the app. */
export type AssistantBuiltInPersonaId = 'analyze' | 'explore';

/**
 * A persona id. Built-ins use {@link AssistantBuiltInPersonaId}; user-defined
 * personas (see user-personas.ts) derive theirs from the file name, validated
 * against the delegation-tool-name charset.
 */
export type AssistantPersonaId = string;

/** Where a persona came from. Absent means built-in (pre-user-persona data). */
export type AssistantPersonaSource = 'built-in' | 'user';

/**
 * Seam for pinning a persona to a cheaper/local model. v1 leaves this undefined
 * on every built-in persona; the agent factory throws if it is set (see D5).
 */
export interface AssistantPersonaModelPin {
  readonly modelId: string;
  readonly provider: string;
}

export interface AssistantPersonaDefinition {
  /** Original (pre-sanitization) native tool ids, e.g. 'brainstrike.grepSearch'. */
  readonly allowedToolIds: readonly string[];
  /** Model-facing delegation tool description (becomes the agent-<id> tool description). */
  readonly description: string;
  readonly id: AssistantPersonaId;
  /** Child system prompt. */
  readonly instructions: string;
  /** Human label for the SubagentCard. */
  readonly label: string;
  /** Hard cap enforced via onDelegationStart.modifiedMaxSteps. */
  readonly maxSteps: number;
  /**
   * Optional model pin: the child runs on `provider::modelId` instead of the
   * parent's model. Resolution (API key + provider client) happens in the
   * agent factory; an unresolvable pin SKIPS the persona with a visible warn,
   * never a silent fallback to the parent model.
   */
  readonly model?: AssistantPersonaModelPin;
  /** Where the persona came from; absent means built-in. */
  readonly source?: AssistantPersonaSource;
}

/** The delegation tool prefix Mastra assigns to `agents`-config children. */
export const SUBAGENT_DELEGATION_TOOL_PREFIX = 'agent-';

export function delegationToolNameForPersona(id: AssistantPersonaId): string {
  return `${SUBAGENT_DELEGATION_TOOL_PREFIX}${id}`;
}

/**
 * Thrown when a persona names a tool that does not resolve to read risk (or is
 * absent from the native-tool registry entirely). Personas are read-only by
 * construction; a non-read tool must never enter a persona's toolset.
 */
export class PersonaToolRiskViolationError extends Error {
  readonly personaId: AssistantPersonaId;
  readonly resolvedRisk: ToolRiskCategory | 'unknown';
  readonly toolId: string;

  constructor(input: {
    personaId: AssistantPersonaId;
    resolvedRisk: ToolRiskCategory | 'unknown';
    toolId: string;
  }) {
    super(
      `Persona '${input.personaId}' names tool '${input.toolId}' whose resolved risk is ` +
        `'${input.resolvedRisk}', not 'read'. Personas must be read-only; declare only ` +
        'read-risk native tool ids.'
    );
    this.name = 'PersonaToolRiskViolationError';
    this.personaId = input.personaId;
    this.resolvedRisk = input.resolvedRisk;
    this.toolId = input.toolId;
  }
}

/**
 * Assert that every tool a persona names resolves to risk `'read'`.
 *
 * Throws {@link PersonaToolRiskViolationError} for any tool that is either absent
 * from {@link NATIVE_TOOL_DEFAULTS} (unknown is not read — no silent fallback) or
 * whose resolved {@link ToolRiskCategory} is not `'read'`.
 */
export function assertReadOnlyPersona(persona: AssistantPersonaDefinition): void {
  for (const toolId of persona.allowedToolIds) {
    const metadata = NATIVE_TOOL_DEFAULTS[toolId];
    if (!metadata) {
      throw new PersonaToolRiskViolationError({
        personaId: persona.id,
        resolvedRisk: 'unknown',
        toolId,
      });
    }
    const risk = resolveToolRiskCategory(metadata);
    if (risk !== 'read') {
      throw new PersonaToolRiskViolationError({
        personaId: persona.id,
        resolvedRisk: risk,
        toolId,
      });
    }
  }
}

function definePersona(persona: AssistantPersonaDefinition): AssistantPersonaDefinition {
  assertReadOnlyPersona(persona);
  return persona;
}

/**
 * Built-in personas (v1: explore, analyze). Each is validated read-only at module
 * init; a regression that adds a non-read tool fails on import.
 */
export const BUILT_IN_PERSONAS: readonly AssistantPersonaDefinition[] = [
  definePersona({
    allowedToolIds: [
      'brainstrike.queryEmbeddingSpace',
      'brainstrike.grepSearch',
      'brainstrike.globWorkspace',
      'brainstrike.readWorkspaceFile',
      'brainstrike.readWorkspaceDirectory',
    ],
    description:
      'Delegate broad, RAG-native codebase exploration: semantic + exact search across the ' +
      'workspace, then read the most relevant files. Use when a question needs surveying many ' +
      'files before answering. Returns a written summary of findings.',
    id: 'explore',
    instructions:
      'You are the Explorer subagent: a read-only codebase exploration specialist. Use semantic ' +
      'search (queryEmbeddingSpace) to find relevant regions when exact wording is unknown, ' +
      'grepSearch for exact identifiers/strings, globWorkspace to enumerate files, and the ' +
      'workspace file/directory readers to inspect the most relevant results. You cannot modify ' +
      'anything. Answer the delegated task concisely with a written summary of what you found, ' +
      'citing concrete file paths.',
    label: 'Explorer',
    maxSteps: 8,
  }),
  definePersona({
    allowedToolIds: [
      'brainstrike.readWorkspaceFile',
      'brainstrike.readWorkspaceDirectory',
      'brainstrike.grepSearch',
      WEB_SEARCH_TOOL_ID,
    ],
    description:
      'Delegate focused analysis that combines reading workspace files with external web ' +
      'research. Use when a question needs both in-repo reading and up-to-date external ' +
      'context. Returns a written analysis.',
    id: 'analyze',
    instructions:
      'You are the Analyst subagent: a read-only analysis specialist. Read workspace files and ' +
      'directories, use grepSearch for exact matches, and webSearch for external context. Note ' +
      'that webSearch sends the query to an external service (Tavily) — do not include private ' +
      'workspace contents in web queries. You cannot modify anything. Answer the delegated task ' +
      'with a concise written analysis, citing sources.',
    label: 'Analyst',
    maxSteps: 8,
  }),
];
