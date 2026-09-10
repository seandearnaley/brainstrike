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
  delegationDescriptionForPersona,
} from '@brainstrike/assistant-contract/personas';
import type { ProviderId } from '@brainstrike/assistant-contract/provider-registry';
import { Agent, type AgentExecutionOptions, type ToolsInput } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { InputProcessor, OutputProcessor } from '@mastra/core/processors';
import {
  resolveToolResultBudgetForModel,
  type ScaledToolResultBudget,
} from '../stream/tool-output-limits';
import type { DelegatedConversationBinding } from './delegated-conversation-binding';
import { ASSISTANT_MAX_PROCESSOR_RETRIES, buildAssistantErrorProcessors } from './error-processors';
import {
  filterToolsByPermissionWithMetadata,
  type PermissionToolGateLogger,
  type PermissionToolGateSnapshot,
} from './permission-tool-gate';
import {
  applyToolModelOutputProjections,
  type ModelOutputProjectionObserver,
} from './tool-model-output';

export interface PersonaSubAgentBuildResult {
  /** 'agent-<personaId>' → personaId, for the stream mapper (D9). */
  readonly delegationToolPersonas: ReadonlyMap<string, string>;
  /** Persona id → resolved persona (for delegation caps + instructions). */
  readonly personasById: ReadonlyMap<string, AssistantPersonaDefinition>;
  /** Persona id → constructed child Agent; keys of `agents` config are persona ids. */
  readonly subAgents: Record<string, Agent>;
}

export interface BuildPersonaSubAgentsParams {
  readonly conversationBinding?: DelegatedConversationBinding;
  /** Parent's post-guard tool map (keyed by sanitized id), RAW — not yet
   * model-output-projected. Each child projects its own selected subset
   * against its own resolved budget (see {@link resolvedToolResultBudget}). */
  readonly guardedTools: ToolsInput;
  /** Parent's resolved model instance (D5 — children reuse it). */
  readonly languageModel: MastraModelConfig;
  readonly logger: PermissionToolGateLogger;
  readonly permissionSnapshot: PermissionToolGateSnapshot | undefined;
  readonly personas: readonly AssistantPersonaDefinition[];
  /**
   * The PARENT run's normalized provider, used to build the child's error
   * processors. A pinned persona overrides it with its own provider.
   */
  readonly provider: string;
  /**
   * The PARENT run's resolved tool-result budget (BST-1206). Un-pinned
   * personas project their tools against this. A pinned persona instead
   * resolves its OWN budget from `persona.model`'s provider/window — see
   * {@link resolvePinnedModel}'s doc comment for why a pin must never
   * silently reuse an unrelated budget.
   */
  readonly resolvedToolResultBudget: ScaledToolResultBudget;
  /**
   * Resolve a pinned persona's model (`persona.model` is set) into a concrete
   * model instance. Provided by the runtime layer, which owns provider/key
   * resolution. A pinned persona is SKIPPED with a visible warn when the
   * resolver is absent or throws — it never silently falls back to the parent
   * model (the author pinned for a reason: cost, capability, or locality).
   * The SAME reasoning extends to its tool-result budget (BST-1206 review):
   * a pin that resolves a model but keeps the parent's budget would size
   * every tool result for the WRONG model's context window.
   */
  readonly resolvePinnedModel?: (persona: AssistantPersonaDefinition) => MastraModelConfig;
  /** sanitizedId → originalName (the parent's map). */
  readonly toolNameMap: ReadonlyMap<string, string>;
  /** Forwarded to `applyToolModelOutputProjections` for every child (BST-1196
   * subagent telemetry attribution — see its call site in agent-runtime.ts). */
  readonly toolOutputObserver?: ModelOutputProjectionObserver;
  readonly turnPersistenceProcessor?: (InputProcessor & OutputProcessor) | undefined;
}

/**
 * The wrap-up instruction a child receives on its reserved final step.
 *
 * Exported so the paired specs can assert the child's LAST prompt actually
 * carried it — a summary the child produced without seeing this would be
 * ungrounded, which is worse than the empty result this replaces.
 */
export const CHILD_WRAP_UP_FEEDBACK =
  'You are at your step limit and this is your final turn — no further tool calls will run. ' +
  'Using ONLY what you already found above, write your summary now: what you looked for, ' +
  'what you found, and the concrete file paths. If you covered only part of the task, say ' +
  'exactly which part you covered and which you did not.';

/**
 * Reserve a child's LAST step for its summary, using Mastra's own
 * `onIterationComplete` hook (docs/subagents.md).
 *
 * A child cut off mid-tool-loop returns `text: ''`, which reaches the supervisor
 * as a successful-but-empty delegation (BST-1410). Mastra's documented remedy is
 * to return `{ continue: false, feedback }` from this hook: core appends the
 * feedback to the child's own message list and grants exactly one more model
 * call before stopping ("the model may get one final turn for a text response
 * that incorporates the feedback").
 *
 * IN-LOOP is the whole point, and why this replaced a bolt-on second
 * `agent.stream()` call. Riding the child's own loop means the summary turn
 * inherits its abort signal, its usage accounting, its memory scoping, and its
 * gathered context for free, and — critically — it is spent from the persona's
 * DECLARED step budget rather than added on top of it. A child with
 * `maxSteps: 8` still costs at most eight model calls.
 *
 * Core only injects the feedback when the model intended to continue (it checks
 * `stepResult.isContinued`), so a child that already answered is never
 * interrupted and a child that stopped on its own is left alone. That gate is
 * the ONLY completion signal this policy relies on.
 *
 * It deliberately does NOT look at the step's `text` (review of #2596). Claude
 * and GPT routinely narrate alongside a tool call ("Let me check the packages
 * directory..."), so text is non-empty on an ordinary tool-looping step.
 * Treating that as "already answering" suppressed the reserve, let the child
 * spend its last step on another tool, and then handed the parent the PREAMBLE
 * as the analysis — non-empty, so the no-answer path never fired either. That is
 * BST-1410 again in a plausible disguise, on exactly the models this targets.
 */
export function buildChildIterationPolicy(): NonNullable<
  AgentExecutionOptions['onIterationComplete']
> {
  return ({ iteration, maxIterations }) => {
    if (typeof maxIterations !== 'number' || maxIterations < 2) {
      // Nothing to reserve: a one-step child has no earlier step to spend on
      // tools, so forcing a wrap-up would consume its only turn.
      return;
    }
    // Fire on the step BEFORE the cap so the reserved turn still fits inside it.
    if (iteration < maxIterations - 1) {
      return;
    }
    return { continue: false, feedback: CHILD_WRAP_UP_FEEDBACK };
  };
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
 * Resolve the model a persona child runs on. Un-pinned personas reuse the
 * parent's model (D5). A pinned persona resolves through `resolvePinnedModel`;
 * when that is absent or throws, the persona is skipped (null) with a warn —
 * never a silent parent-model fallback.
 */
function resolvePersonaModel(
  persona: AssistantPersonaDefinition,
  params: BuildPersonaSubAgentsParams
): MastraModelConfig | null {
  if (!persona.model) {
    return params.languageModel;
  }
  if (!params.resolvePinnedModel) {
    params.logger.warn('Persona pins a model but no pin resolver is available; skipping persona', {
      code: 'subagent_persona_pin_unresolvable',
      modelId: persona.model.modelId,
      personaId: persona.id,
      provider: persona.model.provider,
    });
    return null;
  }
  try {
    return params.resolvePinnedModel(persona);
  } catch (error) {
    params.logger.warn('Persona model pin failed to resolve; skipping persona', {
      code: 'subagent_persona_pin_unresolvable',
      detail: error instanceof Error ? error.message : String(error),
      modelId: persona.model.modelId,
      personaId: persona.id,
      provider: persona.model.provider,
    });
    return null;
  }
}

/**
 * Resolve the tool-result budget a persona child's tools should be projected
 * against (BST-1206 review, P2). Un-pinned personas inherit the parent's
 * resolved budget (they run on the parent's model). A pinned persona resolves
 * its OWN budget from `persona.model`'s provider/window — reusing the
 * parent's would size every tool result for the wrong model's context
 * window, exactly the bug this fixes.
 *
 * `resolveToolResultBudgetForModel` itself no longer throws for an unknown
 * provider/model id (BST-1206 follow-up review): it falls back to the anchor
 * (or the shared Ollama/LM Studio declaration) with a visible log, so a pin
 * to a model absent from the static catalog still gets a sensible budget
 * instead of losing the persona entirely. This try/catch now only guards a
 * genuine registry misconfiguration (e.g. a registered entry with an invalid
 * `contextWindow`, which `resolveScaledToolResultBudget` itself rejects) —
 * mirroring `resolvePersonaModel`'s skip-with-warn contract for that
 * narrower case, never a silent fallback to the parent's budget.
 */
function resolvePersonaToolResultBudget(
  persona: AssistantPersonaDefinition,
  params: BuildPersonaSubAgentsParams
): ScaledToolResultBudget | null {
  if (!persona.model) {
    return params.resolvedToolResultBudget;
  }
  try {
    return resolveToolResultBudgetForModel(
      persona.model.provider as ProviderId,
      persona.model.modelId
    );
  } catch (error) {
    params.logger.warn('Persona model pin has no resolvable tool-result budget; skipping persona', {
      code: 'subagent_persona_pin_budget_unresolvable',
      detail: error instanceof Error ? error.message : String(error),
      modelId: persona.model.modelId,
      personaId: persona.id,
      provider: persona.model.provider,
    });
    return null;
  }
}

/**
 * Build persona child Agents for the parent supervisor.
 */
function buildChildProcessors(params: BuildPersonaSubAgentsParams): {
  inputProcessors?: InputProcessor[];
  outputProcessors?: OutputProcessor[];
} {
  const inputProcessors: InputProcessor[] = [];
  if (params.conversationBinding) {
    inputProcessors.push(params.conversationBinding.inputProcessor);
  }
  if (params.turnPersistenceProcessor) {
    inputProcessors.push(params.turnPersistenceProcessor);
  }
  return {
    ...(inputProcessors.length > 0 ? { inputProcessors } : {}),
    ...(params.turnPersistenceProcessor
      ? { outputProcessors: [params.turnPersistenceProcessor] }
      : {}),
  };
}

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

    const childModel = resolvePersonaModel(persona, params);
    if (childModel === null) {
      continue;
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

    // BST-1206 review (P2): project THIS child's tools against ITS resolved
    // budget — the parent's for an un-pinned persona, the pinned model's own
    // for a pin. Applied here (not once on the parent's map before
    // selection) so a pinned persona never inherits a budget sized for a
    // different model's context window.
    const childToolResultBudget = resolvePersonaToolResultBudget(persona, params);
    if (childToolResultBudget === null) {
      continue;
    }
    const childNameMap = new Map(candidateNameMap);
    const projectedChildTools = applyToolModelOutputProjections(
      childTools as ToolsInput,
      childNameMap,
      params.toolOutputObserver,
      childToolResultBudget
    );

    // The child agent id MUST equal the persona id: Mastra sets
    // `DelegationStartContext.primitiveId = agent.id`, and the delegation caps
    // (subagent-delegation.ts) resolve the persona by that id.
    // Children get the SAME error-processor layer as the parent (review of
    // #2596). Without it a child has no `PrefillErrorHandler`, and the wrap-up
    // turn is exactly when it would be needed: Mastra appends the feedback as an
    // ASSISTANT message, so the child's next request ends on an assistant turn —
    // the assistant-prefill shape that processor exists to recover from. A child
    // that fails precisely when its summary is due would reintroduce BST-1410
    // through the mechanism meant to fix it. Resolved against the child's OWN
    // provider so a pinned persona is handled on its own terms.
    const childErrorProcessors = buildAssistantErrorProcessors(
      persona.model?.provider ?? params.provider
    );
    subAgents[persona.id] = new Agent({
      // Carried on the CHILD so it applies when Mastra invokes the delegation
      // internally: `Agent.stream()` deep-merges `defaultOptions` with the
      // per-call options the delegation tool passes, and that call sets
      // `maxSteps` but never `onIterationComplete`.
      defaultOptions: { onIterationComplete: buildChildIterationPolicy() },
      // Mastra turns this into the `agent-<id>` tool description, the only
      // thing the supervisor reads when sizing a delegation — so it carries the
      // DERIVED step budget rather than the persona's bare prose.
      description: delegationDescriptionForPersona(persona),
      id: persona.id,
      instructions: buildChildInstructions(persona, keptOriginalNames),
      ...buildChildProcessors(params),
      // Any `errorProcessors` flips Mastra's processor-retry default, so the
      // pinned budget travels with them exactly as it does on the parent.
      ...(childErrorProcessors
        ? {
            errorProcessors: childErrorProcessors,
            maxProcessorRetries: ASSISTANT_MAX_PROCESSOR_RETRIES,
          }
        : {}),
      model: childModel,
      name: persona.label,
      tools: projectedChildTools,
    });
    delegationToolPersonas.set(`agent-${persona.id}`, persona.id);
    personasById.set(persona.id, persona);
  }

  return { delegationToolPersonas, personasById, subAgents };
}
