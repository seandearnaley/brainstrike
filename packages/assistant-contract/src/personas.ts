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

import { NATIVE_TOOL_ID } from './native-tool-catalog.js';
import {
  getNativeToolDefaults,
  WEB_EXTRACT_TOOL_ID,
  WEB_SEARCH_TOOL_ID,
} from './tool-categories.js';
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

/**
 * The `metadata.outcome` value on a `subagent.failed` run event marking a
 * delegation whose child ran but returned no written answer (BST-1410).
 *
 * Lives in the contract because it is the wire between the agent-side emitter
 * (`tool-lifecycle-processors.ts`) and the renderer's SubagentCard. Both that
 * case and a hard child `tool-error` are `subagent.failed`/`failed`, so the
 * card must not have to tell them apart by sniffing a human label. A bounded
 * enum string is neither args nor results, so it respects the ids/labels-only
 * rule for subagent metadata.
 */
export const SUBAGENT_NO_ANSWER_OUTCOME = 'no-answer';

/**
 * The model-facing description of a persona's `agent-<id>` delegation tool.
 *
 * The supervisor picks the SIZE of a delegated task from this string and
 * nothing else, so it must disclose the step budget. It used to say only
 * "use when a question needs surveying many files"; the cap surfaced only
 * AFTER a failed delegation, in the no-answer message — the supervisor was
 * invited to over-scope and then told off for it.
 *
 * DERIVED from `maxSteps`, never written into a persona's prose. Two reasons,
 * both load-bearing:
 *
 * 1. There is no second copy to drift. A hardcoded "16 steps" and a
 *    `maxSteps: 16` are two facts that can disagree, and the substring test
 *    guarding them is leaky by construction (`"16"` contains `"1"` and `"6"`).
 * 2. USER-defined personas are covered for free. Their description comes
 *    straight from markdown frontmatter (`user-personas.ts`), which can never
 *    mention a cap, so hardcoding it in the built-ins would have left every
 *    user persona with exactly the bug this fixes.
 *
 * Both places the description reaches a model call this: the child `Agent`
 * config in `build-persona-subagents.ts` (which Mastra turns into the
 * delegation tool) and the supervisor's own instructions via
 * `persona-assembly.ts`.
 */
export function delegationDescriptionForPersona(
  persona: Pick<AssistantPersonaDefinition, 'description' | 'maxSteps'>
): string {
  return (
    `${persona.description} Runs at most ${persona.maxSteps} steps, one of which is reserved ` +
    'for its summary — scope the task to that budget and split anything larger across several ' +
    'delegations.'
  );
}

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
    const metadata = getNativeToolDefaults(toolId);
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
      NATIVE_TOOL_ID.queryEmbeddingSpace,
      NATIVE_TOOL_ID.grepSearch,
      NATIVE_TOOL_ID.globWorkspace,
      NATIVE_TOOL_ID.readToolOutputArtifact,
      NATIVE_TOOL_ID.readWorkspaceFile,
      NATIVE_TOOL_ID.readWorkspaceDirectory,
    ],
    description:
      'Delegate broad, RAG-native codebase exploration: semantic + exact search across the ' +
      'workspace, then read the most relevant files. Use when a question needs surveying many ' +
      'files before answering. Returns reported findings to verify, not established fact.',
    id: 'explore',
    instructions:
      'You are the Explorer subagent: a read-only codebase exploration specialist. Use semantic ' +
      'search (queryEmbeddingSpace) to find relevant regions when exact wording is unknown, ' +
      'grepSearch for exact identifiers/strings, globWorkspace to enumerate files, and the ' +
      'workspace file/directory readers to inspect the most relevant results. You cannot modify ' +
      'anything. Answer the delegated task concisely with a written summary of what you found, ' +
      'citing concrete file paths. State the PROVENANCE of every claim: cite path:line for ' +
      'anything you read in code, and say explicitly when a fact came from documentation or a ' +
      'comment rather than from the code itself — the two are frequently out of sync and your ' +
      'caller cannot tell them apart afterwards. Report only what you actually opened; if you ' +
      'run out of steps, say which part of the task you covered and which you did not, rather ' +
      'than generalising from a sample. Do NOT produce the final deliverable the caller is ' +
      'working towards (a document, a page, a patch) even if the prompt mentions one — you are a ' +
      'research step, and anything beyond findings is wasted budget.',
    label: 'Explorer',
    maxSteps: 16,
  }),
  definePersona({
    allowedToolIds: [
      NATIVE_TOOL_ID.readToolOutputArtifact,
      NATIVE_TOOL_ID.readWorkspaceFile,
      NATIVE_TOOL_ID.readWorkspaceDirectory,
      NATIVE_TOOL_ID.grepSearch,
      WEB_SEARCH_TOOL_ID,
      WEB_EXTRACT_TOOL_ID,
    ],
    description:
      'Delegate focused analysis that combines reading workspace files with external web ' +
      'research. Use when a question needs both in-repo reading and up-to-date external ' +
      'context. Returns reported findings to verify, not established fact.',
    id: 'analyze',
    instructions:
      'You are the Analyst subagent: a read-only analysis specialist. Read workspace files and ' +
      'directories, use grepSearch for exact matches, webSearch for external context, and ' +
      'webExtract to read the pages behind results or user-provided URLs. Note that webSearch ' +
      'and webExtract send the query/URLs to an external service (Tavily) — do not include ' +
      'private workspace contents in web queries or pass internal URLs. You cannot modify ' +
      'anything. Answer the delegated task with a concise written analysis, citing sources. ' +
      'State the PROVENANCE of every claim: cite path:line for anything you read in code, and ' +
      'say explicitly when a fact came from documentation, a comment, or the web rather than ' +
      'from the code itself. Report only what you actually opened; if you run out of steps, say ' +
      'which part of the task you covered and which you did not. Do NOT produce the final ' +
      'deliverable the caller is working towards (a report, a page, a patch) even if the prompt ' +
      'mentions one — you are a research step, and anything beyond findings is wasted budget.',
    label: 'Analyst',
    maxSteps: 16,
  }),
];
