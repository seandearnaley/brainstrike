/**
 * Delegation safety rails (subagent personas, T3 / D7).
 *
 * A per-run {@link DelegationConfig} closure that Mastra invokes around every
 * subagent delegation. It enforces:
 * - **Unknown persona rejection** (no-silent-fallbacks): a delegation to a
 *   `primitiveId` we did not register must never proceed.
 * - **Concurrency + per-run caps**: at most {@link MAX_CONCURRENT_DELEGATIONS} in
 *   flight and {@link MAX_DELEGATIONS_PER_RUN} total.
 * - **maxSteps clamp**: a model-supplied `maxSteps` can never exceed the persona
 *   cap; `onDelegationStart` always returns `modifiedMaxSteps = min(cap, requested)`.
 *
 * `onDelegationComplete` decrements the in-flight counter, logs the outcome,
 * replaces an EMPTY child answer with an explicit reason (BST-1410 — see
 * {@link describeMissingChildAnswer}), and reports the child's aggregate token
 * usage through `onChildUsage`
 * (BST-953) so the stream meters it as a `child-run-usage` chunk — the parent
 * finish counters still exclude child tokens; attribution rides the durable
 * run_kind='subagent' usage row instead.
 */

import type { AssistantRunEventMetadata } from '@brainstrike/assistant-contract';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import type { ScopedLogger } from '@brainstrike/logging';
import type { DelegationConfig } from '@mastra/core/agent';

export const MAX_CONCURRENT_DELEGATIONS = 2;
export const MAX_DELEGATIONS_PER_RUN = 8;

/** The child run's aggregate provider-reported usage (BST-953). */
export interface SubagentChildUsageReport {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly personaId: string;
}

/**
 * Records delegations whose child produced no written answer, keyed by the
 * PARENT tool-call id, so the stream mapper can emit a terminal
 * `subagent.failed` instead of reporting a successful-but-empty delegation as
 * completed. Mirrors {@link DelegationUsageCapture}'s shape and lifetime: built
 * per stream leg alongside the delegation config, then read by the chunk loop.
 *
 * Why a capture rather than inspecting the `tool-result` part: by the time the
 * mapper sees that part, `resultText` has ALREADY replaced the empty text with
 * the explanation, so emptiness is no longer observable there. Only the hook
 * sees the child's own output.
 */
export interface DelegationOutcomeCapture {
  recordNoAnswer(parentToolCallId: string): void;
  returnedNoAnswer(parentToolCallId: string): boolean;
}

export function createDelegationOutcomeCapture(): DelegationOutcomeCapture {
  const withoutAnswer = new Set<string>();
  return {
    recordNoAnswer(parentToolCallId) {
      withoutAnswer.add(parentToolCallId);
    },
    returnedNoAnswer(parentToolCallId) {
      return withoutAnswer.has(parentToolCallId);
    },
  };
}

export interface CreateDelegationConfigParams {
  /** Optional sink for delegations that returned no answer (see above). */
  readonly delegationOutcomes?: DelegationOutcomeCapture;
  readonly logger: ScopedLogger;
  /**
   * Called from `onDelegationComplete` with the child's aggregate usage so the
   * stream can meter it as a `child-run-usage` chunk (run_kind 'subagent').
   * Not called when the child reported no usage — a zero row is noise, and its
   * absence is visible in the completion log which always carries the raw
   * usage object.
   */
  readonly onChildUsage?: (report: SubagentChildUsageReport) => void;
  /** Persona id → definition; the `primitiveId` Mastra passes is the persona id. */
  readonly personasById: ReadonlyMap<string, AssistantPersonaDefinition>;
}

function readTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Normalize the delegation result's usage object (Mastra reports AI SDK v2
 * `inputTokens`/`outputTokens`; older shapes used `promptTokens`/
 * `completionTokens`). Undefined when there is nothing to meter.
 */
function readDelegationUsage(
  usage: unknown
): Pick<SubagentChildUsageReport, 'inputTokens' | 'outputTokens'> | undefined {
  if (typeof usage !== 'object' || usage === null) {
    return;
  }
  const record = usage as Record<string, unknown>;
  const inputTokens = readTokenCount(record['inputTokens'] ?? record['promptTokens']);
  const outputTokens = readTokenCount(record['outputTokens'] ?? record['completionTokens']);
  if (inputTokens === 0 && outputTokens === 0) {
    return;
  }
  return { inputTokens, outputTokens };
}

function clampMaxSteps(cap: number, requested: number | undefined): number {
  if (requested === undefined) {
    return cap;
  }
  return Math.min(cap, requested);
}

/**
 * How many tool calls the child made, when the delegation result carries them.
 *
 * `subAgentToolResults` is present at runtime (`@mastra/core@1.59.0` builds it
 * from `streamResult.toolResults`) but absent from the exported
 * `DelegationCompleteContext['result']` type, so it is narrowed rather than
 * asserted — an unexpected shape yields `undefined`, never a fabricated count.
 */
function readChildToolCallCount(result: unknown): number | undefined {
  if (typeof result !== 'object' || result === null) {
    return;
  }
  const toolResults = (result as { subAgentToolResults?: unknown }).subAgentToolResults;
  return Array.isArray(toolResults) ? toolResults.length : undefined;
}

/**
 * The text the PARENT sees in place of a child's empty answer.
 *
 * Deliberately does NOT assert why the child stopped: the hook never receives a
 * `finishReason`, so claiming "it hit the step cap" would be a guess. It states
 * only what is observable — no answer was written, this many tool calls were
 * made — and names the cap as CONTEXT for re-scoping. That is enough for the
 * supervisor to act, and it is all we can honestly say.
 *
 * Mastra documents `resultText` as existing for exactly this case: "when the
 * sub-agent stopped on a tool-calls step and returned empty text, which reads
 * to the model as a successful but empty delegation."
 */
function describeMissingChildAnswer(persona: AssistantPersonaDefinition, result: unknown): string {
  const toolCallCount = readChildToolCallCount(result);
  if (toolCallCount === undefined) {
    // NOT folded into the zero case (review of #2587): telling the parent a
    // child "made no tool calls" when we simply cannot see them is the same
    // genre of confidently-wrong report this whole change removes, and it would
    // steer the supervisor to redo work that may already be done. Absence is
    // legitimate — `@mastra/core`'s v1/legacy delegation path returns `{ text }`
    // with no `subAgentToolResults` at all — so this is a reportable unknown,
    // not a shape drift to throw on.
    return (
      `The ${persona.id} subagent returned no answer, and its tool activity could not be ` +
      'determined. Treat the delegation as having produced nothing usable, but not as ' +
      'evidence that the task is empty: re-delegate a narrower slice, or gather the ' +
      'material directly.'
    );
  }
  if (toolCallCount === 0) {
    return (
      `The ${persona.id} subagent returned no answer and made no tool calls, so this ` +
      'delegation produced nothing. Do not treat it as an empty result for the task — ' +
      'retry with a more specific prompt, or gather the material directly.'
    );
  }
  return (
    `The ${persona.id} subagent made ${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'} ` +
    'but never wrote its summary, so this delegation returned no analysis. Its raw tool ' +
    `results are unanalysed. The subagent may run at most ${persona.maxSteps} steps, so a ` +
    'task this broad can exhaust them before it answers: re-delegate a narrower slice, or ' +
    'gather the remainder directly.'
  );
}

/**
 * What the PARENT should see when a delegation came back without an answer, or
 * `undefined` when it answered normally (or is not ours to comment on).
 *
 * Extracted from `onDelegationComplete` so that hook stays a lifecycle
 * bookkeeper — decrement, log, attribute usage — and this owns the one question
 * "did the child actually answer, and if not, what do we tell the supervisor?".
 */
async function resolveMissingAnswerResult(
  params: CreateDelegationConfigParams,
  context: Parameters<NonNullable<DelegationConfig['onDelegationComplete']>>[0]
): Promise<{ resultText: string } | undefined> {
  const persona = params.personasById.get(context.primitiveId);
  if (!persona) {
    return;
  }
  // A FAILED delegation is not an unanswered one (review of #2587). The hook
  // fires for both, and a child that threw plausibly arrives with empty text —
  // handing it the step-cap narrative would be a confident, wrong diagnosis of
  // a provider error, and would run a synthesis turn on an agent that just
  // failed. Mastra surfaces the failure through its own tool-error path, which
  // the mapper already maps to `subagent.failed`.
  if (context.success === false) {
    return;
  }
  // The exported type says `string`, but the one place a runtime shape is least
  // likely to match is the path that just went wrong — and a TypeError thrown
  // from inside this hook would be a bad way to find out.
  const text = typeof context.result?.text === 'string' ? context.result.text : '';
  if (text.trim() !== '') {
    return;
  }
  const toolCallCount = readChildToolCallCount(context.result);
  params.logger.warn('Subagent delegation returned no answer', {
    code: 'subagent_delegation_empty_result',
    durationMs: context.duration,
    maxSteps: persona.maxSteps,
    personaId: context.primitiveId,
    ...(toolCallCount === undefined ? {} : { toolCallCount }),
  });
  // No recovery attempt here, deliberately. A child that ran out of steps is
  // given its summary turn INSIDE its own loop by `buildChildIterationPolicy`
  // (Mastra's `onIterationComplete`), so reaching this point means even the
  // reserved step produced nothing — there is no second mechanism to try, and
  // adding one would be the bolt-on the iteration hook replaced.
  params.delegationOutcomes?.recordNoAnswer(context.toolCallId);
  return { resultText: describeMissingChildAnswer(persona, context.result) };
}

/**
 * Build a per-run delegation config. Call ONCE per run (the closure carries the
 * run's in-flight + total counters).
 */
export function createDelegationConfig(params: CreateDelegationConfigParams): DelegationConfig {
  // The closure is rebuilt per stream leg (initial / approval-resume / suspend-
  // resume), so `total` counts delegations WITHIN a leg, not across resumes — the
  // per-run cap is effectively a per-leg cap. Acceptable for v1: a leg is a single
  // model continuation, and cross-leg accumulation would need durable counters.
  let inFlight = 0;
  let total = 0;

  return {
    // All delegation-hook failures propagate, including diagnostics: silently
    // continuing could lose policy enforcement, accounting or failure evidence.
    hookErrorStrategy: 'throw',
    onDelegationComplete: async (context) => {
      inFlight = Math.max(0, inFlight - 1);
      params.logger.info('Subagent delegation completed', {
        code: 'subagent_delegation_completed',
        durationMs: context.duration,
        personaId: context.primitiveId,
        success: context.success,
        usage: context.result.usage,
      });
      const usage = readDelegationUsage(context.result.usage);
      if (usage && params.onChildUsage) {
        params.onChildUsage({ ...usage, personaId: context.primitiveId });
      }
      // Usage is reported BEFORE the empty-answer branch returns: a child that
      // burned minutes of an expensive model and then failed to answer is
      // exactly the case whose cost must still be attributed.
      return await resolveMissingAnswerResult(params, context);
    },
    onDelegationStart: (context) => {
      const persona = params.personasById.get(context.primitiveId);
      if (!persona) {
        params.logger.warn('Rejecting delegation to unknown persona', {
          code: 'subagent_delegation_unknown_persona',
          personaId: context.primitiveId,
        });
        return {
          proceed: false,
          rejectionReason: `Unknown subagent '${context.primitiveId}'.`,
        };
      }

      if (inFlight >= MAX_CONCURRENT_DELEGATIONS) {
        params.logger.warn('Rejecting delegation: concurrency cap reached', {
          code: 'subagent_delegation_concurrency_capped',
          inFlight,
          personaId: context.primitiveId,
        });
        return {
          proceed: false,
          rejectionReason: `Too many concurrent subagents (max ${MAX_CONCURRENT_DELEGATIONS}); try again after the current ones finish.`,
        };
      }

      if (total >= MAX_DELEGATIONS_PER_RUN) {
        params.logger.warn('Rejecting delegation: per-run cap reached', {
          code: 'subagent_delegation_per_run_capped',
          personaId: context.primitiveId,
          total,
        });
        return {
          proceed: false,
          rejectionReason: `Subagent delegation limit reached (max ${MAX_DELEGATIONS_PER_RUN} per turn).`,
        };
      }

      inFlight += 1;
      total += 1;
      return {
        modifiedMaxSteps: clampMaxSteps(persona.maxSteps, context.params.maxSteps),
        proceed: true,
      };
    },
  };
}

/**
 * Tracks which delegations have emitted `subagent.started` but not yet a
 * terminal `subagent.finished`/`.failed` run event, so the stream generator can
 * emit a terminal `subagent.failed` (cancelled) event for any delegation still
 * in flight when the parent run is aborted/cancelled — otherwise a cancelled
 * parent leaves an orphaned `subagent.started` with no counterpart, and the
 * reloaded thread renders a forever-"running" subagent.
 */
export interface DelegationLifecycleTracker {
  /** Return AND clear the metadata of every still-in-flight delegation. */
  drainInFlight(): AssistantRunEventMetadata[];
  /** Clear a delegation that reached a terminal run event. */
  settled(parentToolCallId: string): void;
  /** Record a delegation keyed by its parent (delegation) toolCallId. */
  started(parentToolCallId: string, metadata: AssistantRunEventMetadata): void;
}

export function createDelegationLifecycleTracker(): DelegationLifecycleTracker {
  const inFlight = new Map<string, AssistantRunEventMetadata>();
  return {
    drainInFlight() {
      const orphans = Array.from(inFlight.values());
      inFlight.clear();
      return orphans;
    },
    settled(parentToolCallId) {
      inFlight.delete(parentToolCallId);
    },
    started(parentToolCallId, metadata) {
      inFlight.set(parentToolCallId, metadata);
    },
  };
}

/**
 * Whether persona delegation should be enabled for a run. Personas are skipped
 * for the built-in local provider (D10 — the 2B on-device model's prompt budget
 * cannot afford the delegation tool schemas/guidance) and when there are none.
 */
export function shouldEnablePersonas(
  provider: string,
  personas: readonly AssistantPersonaDefinition[] | undefined
): boolean {
  return provider !== 'local' && Boolean(personas && personas.length > 0);
}
