/**
 * Delegation safety rails (subagent personas, T3 / D7).
 *
 * A per-run {@link DelegationConfig} closure that Mastra invokes around every
 * subagent delegation. It enforces:
 * - **Unknown persona rejection** (no-silent-fallbacks): a delegation to a
 *   `primitiveId` we did not register must never proceed.
 * - **Concurrency + per-run caps**: at most the request's
 *   `subagentSettings.maxConcurrentWork` in flight and `maxInvocations` total.
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

import type {
  AssistantRunEventMetadata,
  DelegatedBudgetPort,
  DelegatedInvocationAdmission,
} from '@brainstrike/assistant-contract';
import {
  type AssistantPersonaDefinition,
  effectiveChildStepBudget,
  personaMode,
} from '@brainstrike/assistant-contract/personas';
import {
  type AssistantDelegatedUsageIdentity,
  isAssistantDelegatedUsageIdentity,
} from '@brainstrike/assistant-contract/run-usage';
import type { RuntimeSubagentSettings } from '@brainstrike/assistant-contract/subagent-settings';
import type { ScopedLogger } from '@brainstrike/logging';
import {
  type DelegationConfig,
  type DelegationStartContext,
  type DelegationStartResult,
  type MastraDBMessage,
  MessageList,
} from '@mastra/core/agent';
import type { DelegatedConversationBinding } from './delegated-conversation-binding';
import {
  type DelegatedSynthesisOutcomes,
  describeTruncatedSynthesis,
} from './delegated-synthesis-outcomes';
import { MAX_DELEGATED_CONTEXT_BYTES } from './delegated-system-context';
import type { DelegatedTurnPersistence } from './delegated-turn-persistence';
import { type DelegatedWorkQueue, resolveDelegatedWorkBudget } from './delegated-work-budget';
import {
  EMBEDDING_ACCESS_FEEDBACK,
  EMBEDDING_PROBE_FEEDBACK,
  summarizeDelegationFailure,
} from './delegation-failure-diagnostic';

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
  /**
   * The child answered, but its RESERVED summary was cut by the model's output
   * limit: a completion with partial findings (`outcome: 'truncated'`), which
   * the tool-result part cannot show because `resultText` already carries the
   * note by then.
   */
  recordTruncation(parentToolCallId: string, parentRuntimeRunId?: string): void;
  rejected(parentToolCallId: string, parentRuntimeRunId?: string): boolean;
  returnedNoAnswer(parentToolCallId: string, parentRuntimeRunId?: string): boolean;
  truncated(parentToolCallId: string, parentRuntimeRunId?: string): boolean;
}

export function createDelegationOutcomeCapture(): DelegationOutcomeCapture {
  const outcomes = new Map<string, 'failed' | 'no-answer' | 'rejected' | 'truncated'>();
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
    recordTruncation(call, run) {
      outcomes.set(key(call, run), 'truncated');
    },
    rejected(call, run) {
      return outcomes.get(key(call, run)) === 'rejected';
    },
    returnedNoAnswer(call, run) {
      return outcomes.get(key(call, run)) === 'no-answer';
    },
    truncated(call, run) {
      return outcomes.get(key(call, run)) === 'truncated';
    },
  };
}

/** The exact prompt facts one child Agent was constructed with (build-persona-subagents). */
export interface ChildPromptFacts {
  readonly instructions: string;
  readonly toolNames: readonly string[];
}

/**
 * The child facts of ONE persona build and the agent that dispatches those
 * children. Nested workers reuse the root's delegation config
 * (`delegatedExecutionOptions.delegation`), so a delegation dispatched by any
 * other agent is NOT described by these facts: its child was built from a
 * narrower tool map.
 */
export interface DelegationChildPromptFacts {
  readonly byPersonaId: ReadonlyMap<string, ChildPromptFacts>;
  readonly dispatchingAgentId: string;
}

/**
 * Debug-pack evidence: what a delegated child is told on its first step
 * (swarm diagnostics, migration 139) — the prompt it receives, the exact
 * instructions its Agent was built with and the tools it kept. Its system
 * context is the root leg's captured set (ruling 2). Recorded only from the
 * facts of the build that constructed the addressed child; any other
 * delegation is logged with a code, never recorded from another agent's facts.
 */
async function recordChildPromptManifest(
  params: CreateDelegationConfigParams,
  context: Pick<DelegationStartContext, 'parentAgentId' | 'runId' | 'threadId' | 'toolCallId'>,
  personaId: string,
  delegationPrompt: string
): Promise<void> {
  const record = params.conversationBinding?.recordPromptManifest;
  if (!record) {
    return;
  }
  const facts =
    params.childPromptFacts?.dispatchingAgentId === context.parentAgentId
      ? params.childPromptFacts.byPersonaId.get(personaId)
      : undefined;
  if (!(facts && context.threadId)) {
    params.logger.warn(
      'Child prompt manifest not recorded: no build facts describe this delegation',
      {
        code: 'subagent_prompt_manifest_unrecorded',
        parentAgentId: context.parentAgentId,
        personaId,
        toolCallId: context.toolCallId,
      }
    );
    return;
  }
  await record({
    delegationPrompt,
    kind: 'child-first-step',
    nativeRunId: context.runId,
    parentToolCallId: context.toolCallId,
    personaId,
    personaInstructions: facts.instructions,
    systemContextSource: 'root-leg',
    systemMessages: [],
    threadId: context.threadId,
    toolNames: facts.toolNames,
  });
}

export interface CreateDelegationConfigParams {
  readonly abortSignal: AbortSignal;
  /** The persona build's child facts, for the child-first-step prompt manifest. */
  readonly childPromptFacts?: DelegationChildPromptFacts;
  readonly conversationBinding?: DelegatedConversationBinding;
  /** Optional sink for delegations that returned no answer (see above). */
  readonly delegationOutcomes?: DelegationOutcomeCapture;
  /** The caller-owned Stop signal; watchdog/attempt aborts do not trip it. */
  readonly externalStopSignal?: AbortSignal;
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
  /**
   * The request's validated limits: every child's step cap is
   * `effectiveChildStepBudget(persona, subagentSettings)`, and the in-flight
   * backstop's concurrency and per-turn caps are its tree limits.
   */
  readonly subagentSettings: RuntimeSubagentSettings;
  /**
   * The runtime's reserved-synthesis registry, written by the child's budget
   * processor. The hook reads it (never the projected stream: it runs before
   * the parent consumer maps the child's parts) to name a truncated summary.
   */
  readonly synthesisOutcomes?: DelegatedSynthesisOutcomes | undefined;
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
): Promise<{ feedback?: string; resultText: string } | undefined> {
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
    if (isExplicitParentStop(params)) {
      return;
    }
    params.delegationOutcomes?.recordFailure(context.toolCallId, context.runId);
    const cause = summarizeDelegationFailure(context.error);
    const feedback =
      cause.causeReason === 'memory-embedding-access-denied'
        ? EMBEDDING_ACCESS_FEEDBACK
        : cause.causeReason === 'memory-embedding-probe-failed'
          ? EMBEDDING_PROBE_FEEDBACK
          : undefined;
    return {
      ...(feedback ? { feedback } : {}),
      resultText: `Subagent "${persona.label}" failed before completing the task. Any partial results remain in its child conversation; do not treat this as a completed deliverable.`,
    };
  }
  // The exported type says `string`, but the one place a runtime shape is least
  // likely to match is the path that just went wrong — and a TypeError thrown
  // from inside this hook would be a bad way to find out.
  const text = typeof context.result?.text === 'string' ? context.result.text : '';
  if (text.trim() !== '') {
    return resolveTruncatedAnswer(params, context, persona, text);
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

function isExplicitParentStop(params: CreateDelegationConfigParams): boolean {
  return params.externalStopSignal?.aborted === true && params.abortSignal.aborted;
}

function logDelegationCompletion(
  params: CreateDelegationConfigParams,
  context: Parameters<NonNullable<DelegationConfig['onDelegationComplete']>>[0]
): void {
  if (context.success !== false) {
    params.logger.info('Subagent delegation completed', {
      code: 'subagent_delegation_completed',
      durationMs: context.duration,
      personaId: context.primitiveId,
      success: context.success,
      usage: context.result.usage,
    });
    return;
  }
  const identity = {
    durationMs: context.duration,
    parentRuntimeRunId: context.runId,
    parentToolCallId: context.toolCallId,
    personaId: context.primitiveId,
  };
  if (isExplicitParentStop(params)) {
    params.logger.info('Subagent delegation cancelled', {
      code: 'subagent_delegation_cancelled',
      ...identity,
    });
    return;
  }
  params.logger.error('Subagent delegation failed', {
    ...summarizeDelegationFailure(context.error),
    code: 'subagent_delegation_failed',
    ...identity,
  });
}

/**
 * A child whose RESERVED summary the model cut at its output limit returned
 * partial findings: the parent reads them plus a `[Truncated summary]` note
 * (never "failed; do not retry"), and the mapper records `outcome:
 * 'truncated'`. Reached only for NON-empty text — an empty truncated summary
 * is still a no-answer. `undefined` when the child's synthesis was not cut or
 * never ran.
 */
function resolveTruncatedAnswer(
  params: CreateDelegationConfigParams,
  context: Parameters<NonNullable<DelegationConfig['onDelegationComplete']>>[0],
  persona: AssistantPersonaDefinition,
  text: string
): { resultText: string } | undefined {
  const childThreadId = context.result?.subAgentThreadId;
  const synthesis = childThreadId ? params.synthesisOutcomes?.read(childThreadId) : undefined;
  if (!synthesis?.truncated) {
    return;
  }
  params.delegationOutcomes?.recordTruncation(context.toolCallId, context.runId);
  params.logger.info('Subagent delegation returned a truncated summary', {
    cap: synthesis.cap,
    code: 'subagent_delegation_truncated',
    limit: synthesis.limit,
    personaId: context.primitiveId,
    reservedOutputTokens: synthesis.reservedOutputTokens,
    used: synthesis.used,
  });
  return { resultText: `${text}${describeTruncatedSynthesis(persona.id, synthesis)}` };
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

/** Parent actions are reference material, not actions performed by this leaf. */
function specialistReference(
  message: MastraDBMessage,
  toolCallId: string,
  index: number
): MastraDBMessage {
  if (message.role === 'system') {
    return message;
  }
  // Native delegation can also supply CoreMessage-shaped content despite its
  // DB-message declaration. Use the native converter to retain structured media.
  const list = new MessageList();
  list.add([message], 'context');
  const normalized = list.get.all.db()[0];
  if (!normalized) {
    throw new Error('Parent reference could not be normalized.');
  }
  return {
    content: {
      format: 2,
      parts: [
        {
          text:
            'Parent conversation reference (not your conversation or actions). ' +
            'Use this only as background for the delegated task that follows. ' +
            "Do not continue the parent's coordination or wait for its other specialists.\n" +
            JSON.stringify({
              content: {
                ...normalized.content,
                parts: normalized.content.parts.filter((part) => part.type !== 'file'),
              },
              role: message.role,
            }),
          type: 'text',
        },
        ...normalized.content.parts.filter((part) => part.type === 'file'),
      ],
    },
    createdAt: normalized.createdAt,
    id: `parent-reference:${toolCallId}:${message.id ?? index}`,
    role: 'user',
  };
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
    messageFilter: ({ messages, primitiveId, toolCallId }) => {
      const persona = params.personasById.get(primitiveId);
      const specialist = persona && personaMode(persona) !== 'worker';
      const protectedMessages = messages.filter((message) => message.role === 'system');
      let bytes = protectedMessages.reduce(
        (sum, message) => sum + Buffer.byteLength(JSON.stringify(message), 'utf8') + 1,
        2
      );
      if (bytes > MAX_DELEGATED_CONTEXT_BYTES) {
        throw new Error('Trusted delegated context exceeds its 64 KiB budget.');
      }
      const selected = new Map(protectedMessages.map((message) => [message, message]));
      let ordinary = 0;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || message.role === 'system') {
          continue;
        }
        if (ordinary >= 16) {
          break;
        }
        const reference = specialist ? specialistReference(message, toolCallId, index) : message;
        const size = Buffer.byteLength(JSON.stringify(reference), 'utf8') + 1;
        if (bytes + size > MAX_DELEGATED_CONTEXT_BYTES) {
          continue;
        }
        selected.set(message, reference);
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
      return messages.flatMap((message) => selected.get(message) ?? []);
    },
    onDelegationComplete: async (context) => {
      inFlight = Math.max(0, inFlight - 1);
      logDelegationCompletion(params, context);
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
        inFlight >= params.subagentSettings.maxConcurrentWork
      ) {
        return reject(
          'Rejecting delegation: concurrency cap reached',
          `Too many concurrent subagents (max ${params.subagentSettings.maxConcurrentWork}); try again after the current ones finish.`,
          'subagent_delegation_concurrency_capped',
          { inFlight }
        );
      }

      if (!resumed && total >= params.subagentSettings.maxInvocations) {
        return reject(
          'Rejecting delegation: per-run cap reached',
          `Subagent delegation limit reached (max ${params.subagentSettings.maxInvocations} per turn).`,
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
        effectiveChildStepBudget(persona, params.subagentSettings),
        context.params.maxSteps
      );
      params.conversationBinding?.prepare(context, { maxSteps, persona }, params.abortSignal);
      params.turnPersistence?.prepare(
        context,
        params.abortSignal,
        params.conversationBinding?.getAbortSignal?.(context.requestContext)
      );
      // Mastra's instructions tool argument is model-authored task content. Keep it
      // in the delegated USER prompt; the child retains host/persona system authority.
      const modifiedPrompt = context.params.instructions
        ? `${context.prompt}\n\nDelegated task details:\n${context.params.instructions}`
        : context.prompt;
      // A parked child resumed inside this leg re-enters the hook at the same
      // address; its first step was recorded when it was admitted.
      if (!resumed) {
        await recordChildPromptManifest(params, context, persona.id, modifiedPrompt);
      }
      return {
        modifiedInstructions: '',
        modifiedMaxSteps: maxSteps,
        modifiedPrompt,
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
