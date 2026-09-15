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

import {
  type AssistantRunEventMetadata,
  DELEGATION_LIMITS,
  type DelegatedBudgetPort,
  type DelegatedInvocationAdmission,
} from '@brainstrike/assistant-contract';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import {
  type AssistantDelegatedUsageIdentity,
  isAssistantDelegatedUsageIdentity,
} from '@brainstrike/assistant-contract/run-usage';
import type { ScopedLogger } from '@brainstrike/logging';
import type {
  DelegationConfig,
  DelegationStartContext,
  DelegationStartResult,
} from '@mastra/core/agent';
import type { DelegatedConversationBinding } from './delegated-conversation-binding';
import { MAX_DELEGATED_CONTEXT_BYTES } from './delegated-system-context';
import type { DelegatedTurnPersistence } from './delegated-turn-persistence';
import { type DelegatedWorkQueue, resolveDelegatedWorkBudget } from './delegated-work-budget';

export const MAX_CONCURRENT_DELEGATIONS = DELEGATION_LIMITS.maxConcurrentWork;
export const MAX_DELEGATIONS_PER_RUN = DELEGATION_LIMITS.maxInvocations;

/** The child run's aggregate provider-reported usage (BST-953). */
export interface SubagentChildUsageReport {
  readonly delegation?: AssistantDelegatedUsageIdentity;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly personaId: string;
}

/**
 * Records delegations whose child produced no written answer, keyed by the
 * PARENT native run and tool-call ids, so the stream mapper can emit a terminal
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
  failed(parentToolCallId: string, parentRuntimeRunId?: string): boolean;
  recordFailure(parentToolCallId: string, parentRuntimeRunId?: string): void;
  recordNoAnswer(parentToolCallId: string, parentRuntimeRunId?: string): void;
  /**
   * The delegation was refused at start (BST-1751): no child ran, and the
   * tool call still succeeds with Mastra's `[Delegation Rejected]` text, so
   * only the hook can tell the mapper it was never a completion.
   */
  recordRejection(parentToolCallId: string, parentRuntimeRunId?: string): void;
  rejected(parentToolCallId: string, parentRuntimeRunId?: string): boolean;
  returnedNoAnswer(parentToolCallId: string, parentRuntimeRunId?: string): boolean;
}

export function createDelegationOutcomeCapture(): DelegationOutcomeCapture {
  const outcomes = new Map<string, 'failed' | 'no-answer' | 'rejected'>();
  const key = (call: string, run?: string) => JSON.stringify([run, call]);
  return {
    failed(call, run) {
      return outcomes.get(key(call, run)) === 'failed';
    },
    recordFailure(call, run) {
      outcomes.set(key(call, run), 'failed');
    },
    recordNoAnswer(call, run) {
      outcomes.set(key(call, run), 'no-answer');
    },
    recordRejection(call, run) {
      outcomes.set(key(call, run), 'rejected');
    },
    rejected(call, run) {
      return outcomes.get(key(call, run)) === 'rejected';
    },
    returnedNoAnswer(call, run) {
      return outcomes.get(key(call, run)) === 'no-answer';
    },
  };
}

export interface CreateDelegationConfigParams {
  readonly abortSignal: AbortSignal;
  readonly conversationBinding?: DelegatedConversationBinding;
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
  readonly turnPersistence?: DelegatedTurnPersistence | undefined;
  readonly workQueue?: DelegatedWorkQueue | undefined;
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
  // failed. Native streaming failures may return a projected tool-result that
  // omits finishReason, so retain the hook's authoritative outcome for mapping.
  if (context.success === false) {
    params.delegationOutcomes?.recordFailure(context.toolCallId, context.runId);
    return {
      resultText: `Subagent "${persona.label}" failed before completing the task. Any partial results remain in its child conversation; do not treat this as a completed deliverable.`,
    };
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
  params.delegationOutcomes?.recordNoAnswer(context.toolCallId, context.runId);
  return { resultText: describeMissingChildAnswer(persona, context.result) };
}

type RejectDelegation = (
  message: string,
  rejectionReason: string,
  code: string,
  fields?: Record<string, unknown>
) => DelegationStartResult;

/**
 * The host's durable tree budget answers BEFORE the child exists. Its later
 * reservation at persist time stays the authority; a refusal here is the same
 * refusal the model would otherwise only meet as a dead root (BST-1751).
 * Returns the rejection to hand Mastra, or undefined when admitted.
 */
async function consultDurableAdmission(
  budget: DelegatedBudgetPort | undefined,
  context: DelegationStartContext,
  reject: RejectDelegation
): Promise<DelegationStartResult | undefined> {
  if (!budget) {
    return;
  }
  const parentThreadId = context.threadId?.trim();
  const parentResourceId = context.resourceId?.trim();
  if (!(parentThreadId && parentResourceId)) {
    throw new Error(
      'Durable delegation admission requires the parent thread and resource identity.'
    );
  }
  let admission: DelegatedInvocationAdmission;
  try {
    admission = await budget.admitInvocation({ parentResourceId, parentThreadId });
  } catch (error) {
    // The host refuses an identity it cannot authorize (root not running, a
    // stopped ancestor, a parent outside this root) with a bounded reason it
    // has already logged. Nothing has run yet, so that refusal costs this one
    // delegation, never the root. Any other failure is a real fault and
    // propagates.
    const reason = readIdentityRefusalReason(error);
    if (reason === undefined) {
      throw error;
    }
    return reject(
      'Rejecting delegation: durable admission identity refused',
      `Delegation admission refused (${reason}).`,
      'subagent_delegation_identity_refused',
      { parentThreadId, reason }
    );
  }
  if (admission.admitted) {
    return;
  }
  return reject(
    'Rejecting delegation: durable budget refused',
    admission.reason,
    'subagent_delegation_budget_refused',
    { parentThreadId }
  );
}

/**
 * Build a per-run delegation config. Call ONCE per run (the closure carries the
 * run's in-flight + total counters).
 */
/**
 * The host's identity error crosses the package boundary by name and its
 * bounded `reason` field (`DelegatedConversationIdentityError` in `@brainstrike/db`,
 * which this package does not depend on).
 */
function readIdentityRefusalReason(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'DelegatedConversationIdentityError') {
    return;
  }
  const reason = (error as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason : undefined;
}

export function createDelegationConfig(params: CreateDelegationConfigParams): DelegationConfig {
  // This per-leg counter remains a backstop. Durable host admission counts the
  // original turn across all descendants and resume legs. With that capability,
  // the shared work queue owns runnable concurrency, not waiting delegations.
  let inFlight = 0;
  let total = 0;
  // Invocations this leg admitted, by native address. A start for an address
  // already admitted is a parked child RESUMED inside this same leg (a live
  // decision): the same invocation continues and holds the slot it already
  // took, so the per-leg caps do not count it again. Durable admission and
  // the binding's own preparation still run, exactly as on a resume leg.
  const admitted = new Set<string>();

  return {
    // All delegation-hook failures propagate, including diagnostics: silently
    // continuing could lose policy enforcement, accounting or failure evidence.
    hookErrorStrategy: 'throw',
    includeSubAgentToolResultsInModelContext: false,
    messageFilter: ({ messages, primitiveId }) => {
      const protectedMessages = messages.filter((message) => message.role === 'system');
      let bytes = protectedMessages.reduce(
        (sum, message) => sum + Buffer.byteLength(JSON.stringify(message), 'utf8') + 1,
        2
      );
      if (bytes > MAX_DELEGATED_CONTEXT_BYTES) {
        throw new Error('Trusted delegated context exceeds its 64 KiB budget.');
      }
      const selected = new Set(protectedMessages);
      let ordinary = 0;
      for (const message of messages.toReversed()) {
        if (message.role === 'system') {
          continue;
        }
        if (ordinary >= 16) {
          break;
        }
        const size = Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;
        if (bytes + size > MAX_DELEGATED_CONTEXT_BYTES) {
          continue;
        }
        selected.add(message);
        bytes += size;
        ordinary += 1;
      }
      if (selected.size !== messages.length) {
        params.logger.info('Delegated context bounded before execution', {
          code: 'subagent_context_pruned',
          omittedMessages: messages.length - selected.size,
          personaId: primitiveId,
        });
      }
      // Return original role/provenance-bearing messages in chronology; never promote task data.
      return messages.filter((message) => selected.has(message));
    },
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
        const delegation = params.conversationBinding
          ? {
              parentRuntimeRunId: context.runId,
              parentToolCallId: context.toolCallId,
              resourceId: context.result.subAgentResourceId,
              threadId: context.result.subAgentThreadId,
            }
          : undefined;
        if (delegation && !isAssistantDelegatedUsageIdentity(delegation)) {
          throw new Error('Delegated usage requires observed native completion identity.');
        }
        params.onChildUsage({
          ...usage,
          ...(delegation ? { delegation } : {}),
          personaId: context.primitiveId,
        });
      }
      // Usage is reported BEFORE the empty-answer branch returns: a child that
      // burned minutes of an expensive model and then failed to answer is
      // exactly the case whose cost must still be attributed.
      return await resolveMissingAnswerResult(params, context);
    },
    onDelegationStart: async (context) => {
      // Every refusal is a tool result the model can read and a recorded
      // outcome for the timeline; none of them starts a child (BST-1751).
      const reject = (
        message: string,
        rejectionReason: string,
        code: string,
        fields: Record<string, unknown> = {}
      ): DelegationStartResult => {
        params.logger.warn(message, {
          code,
          personaId: context.primitiveId,
          rejectionReason,
          ...fields,
        });
        params.delegationOutcomes?.recordRejection(context.toolCallId, context.runId);
        return { proceed: false, rejectionReason };
      };
      const persona = params.personasById.get(context.primitiveId);
      if (!persona) {
        return reject(
          'Rejecting delegation to unknown persona',
          `Unknown subagent '${context.primitiveId}'.`,
          'subagent_delegation_unknown_persona'
        );
      }

      const address = JSON.stringify([context.runId, context.toolCallId]);
      const resumed = admitted.has(address);
      if (
        !(
          resumed ||
          resolveDelegatedWorkBudget(params.conversationBinding?.budget, params.workQueue)
        ) &&
        inFlight >= MAX_CONCURRENT_DELEGATIONS
      ) {
        return reject(
          'Rejecting delegation: concurrency cap reached',
          `Too many concurrent subagents (max ${MAX_CONCURRENT_DELEGATIONS}); try again after the current ones finish.`,
          'subagent_delegation_concurrency_capped',
          { inFlight }
        );
      }

      if (!resumed && total >= MAX_DELEGATIONS_PER_RUN) {
        return reject(
          'Rejecting delegation: per-run cap reached',
          `Subagent delegation limit reached (max ${MAX_DELEGATIONS_PER_RUN} per turn).`,
          'subagent_delegation_per_run_capped',
          { total }
        );
      }

      // The caps are taken BEFORE awaiting the host: parallel starts interleave
      // across that await, and a count read before it would let every sibling
      // pass on the same stale value. A refusal or a failure gives them back.
      if (!resumed) {
        inFlight += 1;
        total += 1;
      }
      const giveBack = () => {
        if (!resumed) {
          inFlight -= 1;
          total -= 1;
        }
      };
      let refusal: DelegationStartResult | undefined;
      try {
        refusal = await consultDurableAdmission(
          params.conversationBinding?.budget,
          context,
          reject
        );
      } catch (error) {
        giveBack();
        throw error;
      }
      if (refusal) {
        giveBack();
        return refusal;
      }
      admitted.add(address);

      const maxSteps = clampMaxSteps(
        Math.min(persona.maxSteps, DELEGATION_LIMITS.maxChildSteps),
        context.params.maxSteps
      );
      params.conversationBinding?.prepare(context, { maxSteps, persona }, params.abortSignal);
      params.turnPersistence?.prepare(
        context,
        params.abortSignal,
        params.conversationBinding?.getAbortSignal?.(context.requestContext)
      );
      return {
        // Mastra's instructions tool argument is model-authored task content. Keep it
        // in the delegated USER prompt; the child retains host/persona system authority.
        modifiedInstructions: '',
        modifiedMaxSteps: maxSteps,
        modifiedPrompt: context.params.instructions
          ? `${context.prompt}\n\nDelegated task details:\n${context.params.instructions}`
          : context.prompt,
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
