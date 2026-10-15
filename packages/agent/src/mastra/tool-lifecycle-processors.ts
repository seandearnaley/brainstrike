/**
 * BST-986: the TOOL-LIFECYCLE half of the Mastra stream boundary — the mutable
 * per-run record plus every mapper that reads or advances it.
 *
 * {@link ToolLifecycleState} is deliberately a mutable record shared by the
 * chunk mappers AND read by the orchestration loop after the loop ends
 * (token diagnostics, missing-finish finalization). Purifying it is explicitly
 * NOT part of this split; the concern being separated here is ownership, so the
 * state and the only code allowed to advance it now live together.
 *
 * The R6 dispatch itself (`processMastraStreamPart`), the static chunk
 * disposition inventory, and `warnForUnrecognizedMastraStreamPart` stay in
 * `agent-streaming.ts` — `scripts/mastra-stream-chunk-contract.mjs` pins all
 * three to that file BY PATH. See docs/agents/mastra-boundary.md R6.
 */
import {
  type AssistantPersonaDefinition,
  SUBAGENT_NO_ANSWER_OUTCOME,
  SUBAGENT_REJECTED_OUTCOME,
  SUBAGENT_TRUNCATED_OUTCOME,
} from '@brainstrike/assistant-contract/personas';
import { createLogger } from '@brainstrike/logging';
import type { AssistantRunEventMetadata } from '../run-events';
import type { ToolExecutionDurations } from '../tools/tool-execution-durations';
import type { RuntimeData, StreamChunk, StreamChunkTool } from '../types';
import type { DelegatedSynthesisOutcomes } from './delegated-synthesis-outcomes';
import {
  asMastraStreamPart,
  getToolCallIdFromToolEvent,
  makeStepMetadata,
  makeToolEventMetadata,
  readFinishReason,
} from '../mastra-boundary/mastra-chunk-decoding';
import {
  type ProviderMetadataStreamPart,
  readCacheTokenCount,
  readOpenRouterBilledCost,
  readStreamPartUsage,
} from '../usage-metering';
import { makeRunEventChunk } from '../tool-projection/stream-run-event-chunks';
import type {
  DelegationLifecycleTracker,
  DelegationOutcomeCapture,
  SubagentChildUsageReport,
} from './subagent-delegation';
import {
  mapMastraToolEvent,
  readMastraStreamPartString,
  readNestedToolOutputChunk,
} from '../tool-projection/tool-event-mapper';

type TerminalToolCallState = 'completed' | 'failed';

interface OutputOnlyToolEvent {
  timestamp: string;
  toolEvent: StreamChunkTool;
}

export interface ToolLifecycleState {
  /** Only calls still needing a terminal; retain their already-resolved display identity. */
  activeToolEvents?: Map<string, StreamChunkTool>;
  /**
   * Token totals from EARLIER attempts of the same turn (BST-1409), zero on a
   * turn that never stalled.
   *
   * Mastra's finish usage is cumulative across the steps of ONE stream, so a
   * continuation's finish reports only its own attempt. These are added back in
   * {@link makeFinishChunk} so the ledger a recovered turn persists is the
   * turn's real spend rather than its last attempt's. Kept separate from
   * `stepped*` because those retain their per-stream meaning for the steered
   * finish, which reads them directly.
   */
  carriedCompletionTokens: number;
  carriedPromptTokens: number;
  delegationLifecycle: DelegationLifecycleTracker;
  /**
   * Which delegations returned no written answer (BST-1410). Absent when the
   * run registered no personas. Read when mapping a delegation `tool-result`:
   * emptiness is invisible on that part, because `resultText` has already
   * replaced the empty text with its explanation by then.
   */
  delegationOutcomes?: DelegationOutcomeCapture;
  firstTextLatencyMs?: number;
  /**
   * Cache token classes are an Anthropic pricing contract (read 0.1×,
   * write 1.25×). Other providers report auto-discounted cached tokens whose
   * rates we do not model — dropping the classes keeps their estimates on the
   * documented conservative full-rate path instead of mispricing them.
   * Keyed off the PARENT run's provider: Mastra does not fold a delegated
   * subagent's model-step usage into the parent finish counter, so a child
   * pinned to a different provider cannot leak foreign cache classes here
   * (review nit, BST-587).
   */
  includeCacheTokenClasses: boolean;
  /** Provider usage for the latest completed step, kept separate from billed sums. */
  latestStepCompletionTokens?: number;
  latestStepPromptTokens?: number;
  outputOnlyToolEvents: Map<string, OutputOnlyToolEvent>;
  /**
   * Prompt tokens SUMMED across the leg's steps — spend, NOT context size
   * (see `UsageMeteringState` in usage-metering.ts for the 2026-08-23
   * misread this naming caused). Per-request size lives in
   * `latestStepPromptTokens`.
   */
  providerReportedPromptTokens?: number;
  requiresBilledCost: boolean;
  /**
   * Whether the model contributed ANYTHING to the turn — a text or reasoning
   * delta containing at least one non-whitespace character, or any
   * tool-lifecycle part — across every attempt. Whitespace-only output is not
   * contribution: that bubble is visually empty too.
   * Carried like the billing flags: a continuation of a turn that already
   * produced output must not re-classify that turn as empty. Read at the
   * terminal `finish`: a turn-level-empty finish is an attempt fault
   * (`EmptyModelResponseError`, retried on the BST-1409 rails), never a
   * silently completed empty bubble.
   */
  sawModelContribution: boolean;
  sawStepBilledCost: boolean;
  sawStepWithoutBilledCost: boolean;
  /**
   * Call ids that already emitted `tool.started` ON THIS LEG.
   *
   * The scope is the point. Since BST-1440 there are TWO producers of a
   * `tool.started` for one approved call — Mastra's own `tool-call` part on the
   * pausing leg, and the synthetic start `makeResumedStartChunks` hands over on
   * the resume leg — and that pair is LEGITIMATE: it is what lets the "needs
   * you" projection clear on answer instead of on completion. The two legs are
   * separate runs with separate `ToolLifecycleState`s, so a per-leg set permits
   * it while still refusing a duplicate WITHIN one leg. A cross-leg guard
   * (persisted, or keyed on the thread) would suppress the resume-leg start and
   * silently restore the bug.
   *
   * What it defends: the resume-leg emission rests on a version-pinned negative
   * — @mastra/core 1.59 never replays a resumed step's `tool-call` part,
   * because its one replay site is gated on a `backgroundTaskManager` this repo
   * does not register. If a bump flips that, or something registers one, the
   * synthetic start and the replayed part land in the SAME leg and we would
   * durably write two `tool.started` rows per approved call, with no error and
   * no log — the same silent-drift failure this change closes on the other side.
   */
  startedToolCallIds: Set<string>;
  /**
   * Mid-run steering (BST-588): polled at each step boundary. When true after
   * a step-finish, the run ends gracefully (run.steered + run.finished events
   * + normal finish) so the queued steer message dispatches as the next turn.
   * Absent control = steering not offered for this run.
   */
  steering?: { stopRequested(): boolean } | undefined;
  stepBilledCostUsd: number;
  /** Number of completed provider steps observed in this run. */
  stepCount: number;
  /**
   * Per-step token usage accumulated across step-finish parts (mirrors
   * stepBilledCostUsd). A steered run's finish reports THIS sum — the
   * boundary step's own usage alone would under-count every earlier step
   * (Mastra's natural terminal usage is the same cross-step sum).
   */
  steppedCompletionTokens: number;
  steppedPromptTokens: number;
  streamStartedAtMs: number;
  /**
   * Per-runtime registry of reserved-synthesis outcomes
   * (`delegated-synthesis-outcomes.ts`). Set on CHILD lifecycle states by the
   * delegated projection so a `length` finish on the synthesis step maps to a
   * truncated completion; absent on the root, where `length` always fails.
   */
  synthesisOutcomes?: DelegatedSynthesisOutcomes;
  terminalToolCallStates: Map<string, TerminalToolCallState>;
  /**
   * Real per-call execution time from the guard wrapper, stamped onto terminal
   * tool run events. Absent on a runtime that did not record (tests, older
   * callers) — then the event carries no `durationMs` and consumers fall back
   * to the timestamp delta, which is the pre-existing behaviour rather than a
   * fabricated number.
   */
  toolExecutionDurations?: ToolExecutionDurations;
  toolExecutionThreadId?: string;
  warnedUnknownChunkTypes: Set<string>;
}

export interface ProcessStreamPartResult {
  chunks: StreamChunk[];
  finished: boolean;
}

const logger = createLogger('MastraToolLifecycle');

/**
 * The turn's provider-reported cost, or `undefined` when it is UNKNOWN.
 *
 * A MISSING COST NEVER FAILS THE TURN — do not relitigate.
 *
 * `requiresBilledCost` is set for every OpenRouter model, but OpenRouter does
 * not report `usage.cost` for anonymous/stealth routes. `stealth/ox-alpha` is
 * one (migration 107, "the anonymous Ox Alpha route"), so EVERY such turn that
 * reached the finish used to throw — discarding a completed assistant answer
 * over a billing-telemetry gap. Cost accounting is observability, and
 * observability must not destroy the product it observes.
 *
 * It stayed hidden because long OpenRouter turns died on the stream inactivity
 * watchdog before ever reaching the finish; fixing that watchdog (#2607) turned
 * the latent bug into an instant failure.
 *
 * The accounting stays honest, which is what the throw was really protecting.
 * Mastra copies providerMetadata from the FINAL model step only, so a terminal
 * cost cannot repair a missing earlier one, and a partial sum presented as the
 * total is exactly the undercount to avoid. An incomplete picture therefore
 * reports UNKNOWN (the ledger stores that as null) — never zero, never a
 * partial. A genuine `cost: 0` is a MEASURED zero and passes through.
 *
 * Malformed metadata still throws inside `readOpenRouterBilledCost`: absent is
 * a fact about the route, malformed is a broken contract.
 */
function resolveBilledCostUsd(
  part: ProviderMetadataStreamPart,
  lifecycleState: ToolLifecycleState
): number | undefined {
  const finishReading = readOpenRouterBilledCost(part);
  if (finishReading.kind === 'malformed') {
    // Same trade as the step path: loud, but never fatal to a finished turn.
    logger.error('Provider reported a malformed billed cost; recording the turn cost as unknown', {
      code: 'provider_billed_cost_malformed',
      reason: finishReading.reason,
    });
  }
  const finishCost = finishReading.kind === 'reported' ? finishReading.usd : undefined;
  if (!lifecycleState.requiresBilledCost) {
    return lifecycleState.sawStepBilledCost ? lifecycleState.stepBilledCostUsd : finishCost;
  }
  const costIsUnknown =
    lifecycleState.sawStepWithoutBilledCost ||
    finishReading.kind === 'malformed' ||
    (!lifecycleState.sawStepBilledCost && finishCost === undefined);
  if (costIsUnknown) {
    // The PARTIAL case is called out separately, and carries the amount being
    // dropped. `stepBilledCostUsd` there holds real provider-reported spend
    // that the turn total cannot honestly use — but "we discarded $0.004 of
    // known cost" is exactly the thing a field investigation needs to see, and
    // a message saying "no billed cost" would be false on that branch.
    //
    // It matters more than it looks: `sawStepWithoutBilledCost` is carried
    // across retry attempts, so ONE cost-less step anywhere in a multi-attempt
    // turn drops the whole turn's known spend to unknown.
    logger.warn(
      lifecycleState.sawStepBilledCost
        ? 'Provider reported a cost for only some steps; recording the turn cost as unknown'
        : 'Provider reported no billed cost; recording the turn cost as unknown',
      {
        code: 'provider_billed_cost_unreported',
        ...(lifecycleState.sawStepBilledCost
          ? { discardedPartialCostUsd: lifecycleState.stepBilledCostUsd }
          : {}),
        sawStepBilledCost: lifecycleState.sawStepBilledCost,
        sawStepWithoutBilledCost: lifecycleState.sawStepWithoutBilledCost,
        stepCount: lifecycleState.stepCount,
      }
    );
    return;
  }
  return lifecycleState.sawStepBilledCost ? lifecycleState.stepBilledCostUsd : finishCost;
}

export function makeFinishChunk(part: unknown, lifecycleState: ToolLifecycleState): StreamChunk {
  const p = asMastraStreamPart(part);
  const usage = readStreamPartUsage(p) ?? {};
  const promptTokensRaw = usage.promptTokens ?? usage.inputTokens;
  const attemptPromptTokens = Number.isFinite(promptTokensRaw) ? (promptTokensRaw ?? 0) : 0;
  const promptTokens = attemptPromptTokens + lifecycleState.carriedPromptTokens;
  const completionTokensRaw = usage.completionTokens ?? usage.outputTokens;
  const attemptCompletionTokens = Number.isFinite(completionTokensRaw)
    ? (completionTokensRaw ?? 0)
    : 0;
  const completionTokens = attemptCompletionTokens + lifecycleState.carriedCompletionTokens;
  // CONTEXT sizes describe the latest step's prompt, not the turn's spend, so
  // they stay on this attempt's numbers — adding earlier attempts would claim a
  // context window that never existed.
  const contextInputTokens = lifecycleState.latestStepPromptTokens ?? attemptPromptTokens;
  const contextOutputTokens = lifecycleState.latestStepCompletionTokens ?? attemptCompletionTokens;
  const billedCostUsd = resolveBilledCostUsd(p, lifecycleState);
  const cacheReadInputTokens = lifecycleState.includeCacheTokenClasses
    ? readCacheTokenCount(usage.cachedInputTokens)
    : undefined;
  const cacheCreationInputTokens = lifecycleState.includeCacheTokenClasses
    ? readCacheTokenCount(usage.cacheCreationInputTokens)
    : undefined;
  return {
    ...(billedCostUsd === undefined ? {} : { billedCostUsd }),
    finishReason: readFinishReason(part),
    path: [],
    type: 'message-finish',
    usage: {
      completionTokens,
      contextInputTokens,
      contextOutputTokens,
      promptTokens,
      ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
      ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    },
  };
}

export function makeLifecycleStepMetadata(
  part: unknown,
  lifecycleState: ToolLifecycleState
): AssistantRunEventMetadata | undefined {
  const metadata: AssistantRunEventMetadata = {
    ...(makeStepMetadata(part) ?? {}),
    ...(lifecycleState.firstTextLatencyMs === undefined
      ? {}
      : { firstTextLatencyMs: lifecycleState.firstTextLatencyMs }),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * `run.step.finished` metadata: the lifecycle step metadata plus the step's own
 * `finishReason` (debug pack, 2026-09-15), so a `length`-cut step is visible
 * without waiting for the terminal event. Deliberately NOT in
 * `makeStepMetadata`: that also feeds `run.started`, `run.step.started`,
 * `run.steered`, the steered `run.finished` and the stream-termination rows,
 * where a step's reason would contradict the run's terminal (a steered finish
 * reports `stop`). `'absent'` is the reader's no-value sentinel, never written.
 */
export function makeStepFinishedMetadata(
  part: unknown,
  lifecycleState: ToolLifecycleState
): AssistantRunEventMetadata | undefined {
  const metadata = makeLifecycleStepMetadata(part, lifecycleState);
  const finishReason = readFinishReason(part);
  if (finishReason === 'absent') {
    return metadata;
  }
  return { ...metadata, finishReason };
}

export function recordFirstTextLatency(delta: string, lifecycleState: ToolLifecycleState): void {
  if (delta.length === 0 || lifecycleState.firstTextLatencyMs !== undefined) {
    return;
  }
  lifecycleState.firstTextLatencyMs = Math.max(0, Date.now() - lifecycleState.streamStartedAtMs);
}

/**
 * Finish reasons {@link makeTerminalRunEvent} maps to a COMPLETED run. Also the
 * gate for the empty-model-response guard: only a finish that would otherwise
 * complete is re-classified as an attempt fault when the model contributed
 * nothing — an abnormal reason (`length`, a provider failure sentinel) already
 * fails the run with its own, more precise truth.
 */
export const COMPLETED_FINISH_REASONS: ReadonlySet<string> = new Set([
  'absent',
  'stop',
  'tool-calls',
  'unknown',
]);

export function makeTerminalRunEvent(
  part: unknown,
  lifecycleState: ToolLifecycleState
): StreamChunk {
  const finishReason = readFinishReason(part);
  const terminalMetadata: AssistantRunEventMetadata = {
    ...(makeLifecycleStepMetadata(part, lifecycleState) ?? {}),
    finishReason,
  };
  if (COMPLETED_FINISH_REASONS.has(finishReason)) {
    return makeRunEventChunk(
      'run.finished',
      'completed',
      'Assistant run completed',
      terminalMetadata
    );
  }
  const synthesis =
    finishReason === 'length' && lifecycleState.toolExecutionThreadId
      ? lifecycleState.synthesisOutcomes?.read(lifecycleState.toolExecutionThreadId)
      : undefined;
  if (synthesis?.truncated) {
    // The reserved summary was cut by the provider's output limit: the child
    // COMPLETED with partial findings (GLM pack 2026-09-15). A mid-run
    // `length` has no recorded synthesis and stays the failure below.
    return makeRunEventChunk(
      'run.finished',
      'completed',
      'Subagent summary truncated at its synthesis budget',
      {
        ...terminalMetadata,
        outcome: SUBAGENT_TRUNCATED_OUTCOME,
        reservedOutputTokens: synthesis.reservedOutputTokens,
      }
    );
  }
  const label =
    finishReason === 'length'
      ? 'Assistant run reached the model output token limit'
      : `Assistant run ended abnormally (${finishReason})`;
  return makeRunEventChunk('run.failed', 'failed', label, terminalMetadata);
}

/**
 * Terminal `subagent.failed` (cancelled) chunks for every delegation still in
 * flight when the parent run aborts — so a cancelled parent never leaves an
 * orphaned `subagent.started` with no counterpart.
 */
export function makeCancelledDelegationRunEventChunks(
  lifecycleState: ToolLifecycleState
): StreamChunk[] {
  return lifecycleState.delegationLifecycle
    .drainInFlight()
    .map((metadata) =>
      makeRunEventChunk('subagent.failed', 'cancelled', 'Subagent cancelled', metadata)
    );
}

/**
 * Stamp the terminal tool run event with the time `execute` actually ran.
 *
 * `AssistantRunEvent.durationMs` already exists in the contract; tool events
 * simply never populated it, leaving consumers to subtract `tool.started`'s
 * timestamp. That subtraction is wrong for an approval-gated call: the gate
 * suspends BEFORE `execute` is invoked, so the gap spans the human approval
 * wait — a two-second script behind a five-minute approval read as five
 * minutes. Only the guard wrapper sees the real window.
 *
 * No recorded duration leaves the event unchanged rather than inventing one.
 */
function withToolExecutionDuration(
  chunk: StreamChunk,
  lifecycleState: ToolLifecycleState,
  toolCallId: string
): StreamChunk {
  const durationMs = lifecycleState.toolExecutionDurations?.read(
    toolCallId,
    lifecycleState.toolExecutionThreadId
  );
  if (durationMs === undefined) {
    return chunk;
  }
  return withRunEventDuration(chunk, durationMs);
}

/**
 * Attach a duration to a run-event chunk.
 *
 * NARROWS rather than asserting: an unchecked cast would silently corrupt any
 * non-run-event chunk a future caller passed through, and the value is only
 * known to be a run event by construction at today's call sites.
 */
function withRunEventDuration(chunk: StreamChunk, rawDurationMs: number): StreamChunk {
  // INTEGER MILLISECONDS, enforced at the single seam where a duration enters
  // a run event. The guard wrapper measures with `performance.now()`, whose
  // deltas are fractional — and `brainstrike_assistant_run_events.duration_ms`
  // is an INTEGER column, so forwarding the raw float made EVERY stamped
  // terminal tool event fail to persist (field regression 2026-08-23, 22P02
  // "invalid input syntax for type integer"), punching holes in the durable
  // timeline the debug bundle reads. A non-finite value drops the field
  // entirely rather than persisting garbage. Deliberately INTEGRALITY only:
  // the column would also reject values past 2^31-1 (22003), but a single
  // call measuring ~24.8 days is not a real input — a clamp here would be
  // dead code wearing a safety label.
  const durationMs = Math.round(rawDurationMs);
  if (chunk.type !== 'run-event' || !Number.isFinite(durationMs)) {
    return chunk;
  }
  return { ...chunk, event: { ...chunk.event, durationMs } };
}

/**
 * THE SINGLE OWNER of "a mapped tool event implies its durable run event".
 *
 * Exported (BST-1440) so the approval-RESUME leg reaches the same decision the
 * mainline does. Mastra never replays a suspended step's `tool-call` part on a
 * resume leg — `approveToolCall` delegates to `resumeStream`, which re-executes
 * `toolCallStep` with `messages: []`, and the only `tool-call` replay inside
 * that step is gated on a background-task manager Brainstrike does not register
 * (@mastra/core 1.59). So `makeResumedStartChunks` in `agent-streaming.ts`
 * SYNTHESISES the `status: 'start'` tool event and hands it here, exactly as
 * {@link mapGenericToolEvent} hands over the mapped one. A second
 * `makeRunEventChunk('tool.started', ...)` call site would have been the
 * shorter edit and is precisely how the resume leg drifted out of step in the
 * first place: the start chunk shipped, the run event did not, and the "needs
 * you" glyph stayed lit until the approved tool FINISHED.
 *
 * `mastraPartType` is the Mastra part the event came from; the resume leg
 * passes `'tool-call'` because that is the part it stands in for.
 */
/**
 * `tool.started`, at most once per call PER LEG.
 *
 * Extracted rather than inlined in the switch because the idempotence check
 * pushed {@link makeToolLifecycleRunEventChunk} past the cognitive-complexity
 * ceiling — and because the per-leg scope deserves to be stated where it is
 * enforced. The pausing leg and the resume leg each emit one start for an
 * approved call and BOTH are wanted; see
 * {@link ToolLifecycleState.startedToolCallIds} for why a wider scope would
 * silently undo BST-1440.
 */
function makeToolStartedRunEventChunk(
  toolCallId: string | undefined,
  metadata: AssistantRunEventMetadata,
  lifecycleState: ToolLifecycleState,
  toolEvent: StreamChunkTool
): StreamChunk | undefined {
  if (!toolCallId) {
    return;
  }
  if (lifecycleState.startedToolCallIds.has(toolCallId)) {
    return;
  }
  lifecycleState.startedToolCallIds.add(toolCallId);
  lifecycleState.activeToolEvents ??= new Map();
  lifecycleState.activeToolEvents.set(toolCallId, toolEvent);
  return makeRunEventChunk('tool.started', 'running', 'Tool started', metadata);
}

export function makeToolLifecycleRunEventChunk(
  toolEvent: StreamChunkTool,
  mastraPartType: string | undefined,
  lifecycleState: ToolLifecycleState
): StreamChunk | undefined {
  const toolCallId = getToolCallIdFromToolEvent(toolEvent);
  const metadata = makeToolEventMetadata(toolEvent);

  switch (toolEvent.status) {
    case 'start':
      return makeToolStartedRunEventChunk(toolCallId, metadata, lifecycleState, toolEvent);
    case 'success': {
      if (!toolCallId) {
        // Mastra terminal tool parts must carry the same stable call id as their
        // start part. Name-based matching would be ambiguous for concurrent
        // same-name tool calls, so durable terminal events are not guessed.
        return;
      }
      if (mastraPartType === 'tool-output') {
        if (!lifecycleState.terminalToolCallStates.has(toolCallId)) {
          lifecycleState.outputOnlyToolEvents.set(toolCallId, {
            timestamp: new Date().toISOString(),
            toolEvent,
          });
        }
        return;
      }
      if (lifecycleState.terminalToolCallStates.has(toolCallId)) {
        return;
      }
      lifecycleState.terminalToolCallStates.set(toolCallId, 'completed');
      lifecycleState.activeToolEvents?.delete(toolCallId);
      lifecycleState.outputOnlyToolEvents.delete(toolCallId);
      return withToolExecutionDuration(
        makeRunEventChunk('tool.completed', 'completed', 'Tool completed', metadata),
        lifecycleState,
        toolCallId
      );
    }
    case 'error': {
      if (!toolCallId) {
        return;
      }
      if (lifecycleState.terminalToolCallStates.has(toolCallId)) {
        return;
      }
      lifecycleState.terminalToolCallStates.set(toolCallId, 'failed');
      lifecycleState.activeToolEvents?.delete(toolCallId);
      lifecycleState.outputOnlyToolEvents.delete(toolCallId);
      return withToolExecutionDuration(
        makeRunEventChunk('tool.failed', 'failed', 'Tool failed', metadata),
        lifecycleState,
        toolCallId
      );
    }
    case 'declined': {
      if (!toolCallId) {
        return;
      }
      if (lifecycleState.terminalToolCallStates.has(toolCallId)) {
        return;
      }
      lifecycleState.terminalToolCallStates.set(toolCallId, 'failed');
      lifecycleState.activeToolEvents?.delete(toolCallId);
      lifecycleState.outputOnlyToolEvents.delete(toolCallId);
      // A declined `requireApproval` call (@mastra/core 1.59 `tool-output-denied`)
      // keeps the `tool.failed` KIND deliberately, and only relabels. The kind is
      // what `getMatchingFailedKind` pairs `tool.started` against and what
      // `collectToolDurations` / `RUN_LEDGER_AGGREGATION_SQL` close a call out
      // on — and here the call really IS over: the framework consumed the
      // decline, the tool never runs, and no later terminal part carries this id.
      // That is the opposite of `tool.resume.unsupported` (BST-558), whose run
      // stays suspended and can still emit the real terminal later.
      // ZERO, explicitly — not via the recorder. The recorder means "measured";
      // this means "known not to have run". Without it the consumer falls back
      // to the tool.started → terminal gap, which for a decline is the human's
      // deliberation time: deny after five minutes and the card claims the tool
      // ran for five minutes.
      return withRunEventDuration(
        makeRunEventChunk('tool.failed', 'failed', 'Tool call declined', metadata),
        0
      );
    }
    case 'progress':
      return;
  }
}

export function makePendingToolOutputRunEventChunks(
  lifecycleState: ToolLifecycleState
): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const [toolCallId, outputOnlyToolEvent] of lifecycleState.outputOnlyToolEvents) {
    if (lifecycleState.terminalToolCallStates.has(toolCallId)) {
      continue;
    }
    lifecycleState.terminalToolCallStates.set(toolCallId, 'completed');
    lifecycleState.activeToolEvents?.delete(toolCallId);
    // Sequence remains the ordering source of truth; this timestamp preserves
    // when the output-only terminal observation happened for duration metrics.
    chunks.push(
      // Stamped here too: this is a SUPPORTED terminal shape (a `tool-output`
      // success with no following `tool-result`), and a stamp applied only on
      // the tool-result path would leave it falling back to the
      // start-to-terminal gap — approval wait included.
      withToolExecutionDuration(
        makeRunEventChunk(
          'tool.completed',
          'completed',
          'Tool completed',
          makeToolEventMetadata(outputOnlyToolEvent.toolEvent),
          outputOnlyToolEvent.timestamp
        ),
        lifecycleState,
        toolCallId
      )
    );
  }
  lifecycleState.outputOnlyToolEvents.clear();
  return chunks;
}

/**
 * Resolve the delegation persona id for a parent `tool-call`/`tool-result`/
 * `tool-error` part whose tool is an `agent-<key>` delegation tool, or undefined
 * when it is an ordinary tool. Delegation tool names are Mastra-constructed
 * (`agent-<personaId>`) and never enter the sanitized name map, so the raw
 * toolName equals the key we look up.
 */
export function resolveDelegationPersona(
  part: unknown,
  toolNames: Map<string, string>,
  delegationToolPersonas: ReadonlyMap<string, string>
): { parentToolCallId: string | undefined; personaId: string; toolName: string } | undefined {
  if (delegationToolPersonas.size === 0) {
    return;
  }
  const callId =
    readMastraStreamPartString(part, 'toolCallId') ?? readMastraStreamPartString(part, 'id');
  const rawToolName =
    readMastraStreamPartString(part, 'toolName') ??
    readMastraStreamPartString(part, 'name') ??
    (callId ? toolNames.get(callId) : undefined);
  if (!rawToolName) {
    return;
  }
  const personaId = delegationToolPersonas.get(rawToolName);
  if (!personaId) {
    return;
  }
  return { parentToolCallId: callId, personaId, toolName: rawToolName };
}

/**
 * Map a delegation `tool-output` part (nested child chunk forwarded on the parent
 * stream, §2.5) into `subagent.tool.*` run events. The generic `mapMastraToolEvent`
 * path is deliberately BYPASSED for these parts (it would emit a bogus
 * successful tool event + `toolCallResult` frame per nested chunk). Child
 * text/reasoning/step/finish chunks produce NOTHING.
 */
export function mapDelegationToolOutput(
  part: unknown,
  parentToolCallId: string | undefined,
  personaId: string,
  delegationToolName: string
): StreamChunk[] {
  const nested = readNestedToolOutputChunk(part);
  if (!nested) {
    return [];
  }
  const baseMetadata: AssistantRunEventMetadata = {
    personaId,
    ...(parentToolCallId ? { parentToolCallId } : {}),
    toolName: delegationToolName,
  };
  const childMetadata: AssistantRunEventMetadata = {
    ...baseMetadata,
    ...(nested.toolCallId ? { toolCallId: nested.toolCallId } : {}),
    ...(nested.toolName ? { childToolName: nested.toolName } : {}),
  };
  if (nested.type === 'tool-call') {
    return [
      makeRunEventChunk('subagent.tool.started', 'running', 'Subagent tool started', childMetadata),
    ];
  }
  if (nested.type === 'tool-result') {
    return [
      nested.isError
        ? makeRunEventChunk('subagent.tool.failed', 'failed', 'Subagent tool failed', childMetadata)
        : makeRunEventChunk(
            'subagent.tool.completed',
            'completed',
            'Subagent tool completed',
            childMetadata
          ),
    ];
  }
  if (nested.type === 'tool-error') {
    return [
      makeRunEventChunk('subagent.tool.failed', 'failed', 'Subagent tool failed', childMetadata),
    ];
  }
  return [];
}

/** The generic (non-delegation) tool-event mapping shared by every tool part. */
export function mapGenericToolEvent(
  part: unknown,
  toolNames: Map<string, string>,
  lifecycleState: ToolLifecycleState,
  partType: string,
  sanitizedNameMap?: Map<string, string>
): ProcessStreamPartResult {
  const evt = mapMastraToolEvent(part, toolNames, sanitizedNameMap);
  if (!(evt && evt.type === 'tool-event')) {
    return { chunks: [], finished: false };
  }
  const runEvent = makeToolLifecycleRunEventChunk(evt, partType, lifecycleState);
  return {
    chunks: runEvent ? [evt, runEvent] : [evt],
    finished: false,
  };
}

/**
 * Per-leg bridge from `onDelegationComplete` (a Mastra callback OUTSIDE the
 * chunk loop) to the stream: completed child usage queues here and the
 * generator drains bound reports at their matching parent terminal, after
 * native child publication. A completion may race ahead of a slow consumer;
 * an unrelated earlier part must not publish unbound usage. Unbound reports
 * retain next-part delivery, with a post-loop drain for both paths. Model attribution is the
 * persona's model pin when present, else the parent run's model — the same
 * resolution the child actually executed with (never a guess).
 */
export interface DelegationUsageCapture {
  drain: (part?: unknown) => StreamChunk[];
  onChildUsage: (report: SubagentChildUsageReport) => void;
  onPublishedChildUsage: (report: SubagentChildUsageReport) => void;
}

export function createDelegationUsageCapture(
  personasById: ReadonlyMap<string, AssistantPersonaDefinition>,
  runtimeData: RuntimeData | undefined
): DelegationUsageCapture {
  const pending: Extract<StreamChunk, { type: 'child-run-usage' }>[] = [];
  const published = new Set<string>();
  const reported = new Map<string, { inputTokens: number; outputTokens: number }>();
  const usageKey = (identity: SubagentChildUsageReport['delegation']) =>
    JSON.stringify(
      identity && [
        identity.parentRuntimeRunId,
        identity.parentToolCallId,
        identity.resourceId,
        identity.threadId,
      ]
    );
  const enqueue = (incoming: SubagentChildUsageReport) => {
    let report = incoming;
    if (report.delegation) {
      const key = JSON.stringify([usageKey(report.delegation), report.personaId]);
      const previous = reported.get(key);
      if (
        previous &&
        report.inputTokens <= previous.inputTokens &&
        report.outputTokens <= previous.outputTokens
      ) {
        return;
      }
      report = {
        ...report,
        inputTokens: Math.max(previous?.inputTokens ?? 0, report.inputTokens),
        outputTokens: Math.max(previous?.outputTokens ?? 0, report.outputTokens),
      };
      reported.set(key, report);
    }
    const pin = personasById.get(report.personaId)?.model;
    const model = pin?.modelId ?? runtimeData?.model;
    const provider = pin?.provider ?? runtimeData?.provider;
    const existing = pending.find(
      (chunk) =>
        report.delegation && usageKey(chunk.value.delegation) === usageKey(report.delegation)
    );
    if (existing) {
      existing.value = {
        ...existing.value,
        inputTokens: Math.max(existing.value.inputTokens, report.inputTokens),
        outputTokens: Math.max(existing.value.outputTokens, report.outputTokens),
      };
      return;
    }
    pending.push({
      type: 'child-run-usage',
      value: {
        ...(report.delegation ? { delegation: report.delegation } : {}),
        estimated: false,
        inputTokens: report.inputTokens,
        ...(model ? { model } : {}),
        outputTokens: report.outputTokens,
        personaId: report.personaId,
        ...(provider ? { provider } : {}),
        source: 'subagent',
      },
    });
  };
  return {
    drain: (part) => {
      if (pending.length === 0) {
        return [];
      }
      if (part === undefined) {
        return pending.splice(0);
      }
      const event = asMastraStreamPart(part);
      const ready: StreamChunk[] = [];
      for (let index = 0; index < pending.length; ) {
        const chunk = pending[index];
        if (!chunk) {
          break;
        }
        const identity = chunk.value.delegation;
        const terminal =
          event.type === 'finish' ||
          ((event.type === 'tool-result' || event.type === 'tool-error') &&
            readMastraStreamPartString(event.payload, 'toolCallId') === identity?.parentToolCallId);
        if (
          !identity ||
          published.has(usageKey(identity)) ||
          (terminal && event.runId === identity.parentRuntimeRunId)
        ) {
          ready.push(chunk);
          pending.splice(index, 1);
        } else {
          index += 1;
        }
      }
      return ready;
    },
    onChildUsage: enqueue,
    onPublishedChildUsage(report) {
      if (!report.delegation) {
        throw new Error('Published usage has no bound delegation.');
      }
      published.add(usageKey(report.delegation));
      enqueue(report);
    },
  };
}

/** Every Mastra part type that carries a delegation's own lifecycle. */
export type DelegationLifecyclePartType =
  | 'tool-call'
  | 'tool-error'
  | 'tool-output-denied'
  | 'tool-result';

/** What the delegation hook recorded about a tool-result that LOOKS successful. */
type RecordedDelegationOutcome =
  | typeof SUBAGENT_NO_ANSWER_OUTCOME
  | typeof SUBAGENT_REJECTED_OUTCOME
  | typeof SUBAGENT_TRUNCATED_OUTCOME
  | undefined;

function resolveRecordedDelegationOutcome(
  partType: DelegationLifecyclePartType,
  parentToolCallId: string | undefined,
  parentRuntimeRunId: string | undefined,
  outcomes: DelegationOutcomeCapture | undefined
): RecordedDelegationOutcome {
  if (partType !== 'tool-result' || !(parentToolCallId && outcomes)) {
    return;
  }
  if (outcomes.rejected(parentToolCallId, parentRuntimeRunId)) {
    return SUBAGENT_REJECTED_OUTCOME;
  }
  if (outcomes.returnedNoAnswer(parentToolCallId, parentRuntimeRunId)) {
    return SUBAGENT_NO_ANSWER_OUTCOME;
  }
  if (outcomes.truncated(parentToolCallId, parentRuntimeRunId)) {
    return SUBAGENT_TRUNCATED_OUTCOME;
  }
  return;
}

/** The subagent.* run event that mirrors a delegation tool-call/result/error/decline. */
function makeSubagentLifecycleChunk(
  partType: DelegationLifecyclePartType,
  metadata: AssistantRunEventMetadata,
  outcome: RecordedDelegationOutcome
): StreamChunk {
  if (partType === 'tool-call') {
    return makeRunEventChunk('subagent.started', 'running', 'Subagent started', metadata);
  }
  if (partType === 'tool-error') {
    return makeRunEventChunk('subagent.failed', 'failed', 'Subagent failed', metadata);
  }
  if (partType === 'tool-output-denied') {
    // The user declined the delegation at its approval gate, so the child never
    // ran. It is still a TERMINAL for the `subagent.started` the parent's
    // `tool-call` already emitted — the same "never leave an orphan" rule
    // `makeCancelledDelegationRunEventChunks` enforces on the abort path — so
    // the decline must not be the one delegation terminal that goes unemitted.
    // `'cancelled'`, not `'failed'`: nothing broke, the user chose.
    return makeRunEventChunk(
      'subagent.failed',
      'cancelled',
      'Subagent delegation declined',
      metadata
    );
  }
  if (outcome === SUBAGENT_REJECTED_OUTCOME) {
    // BST-1751. The delegation was refused at start — by a backstop or by the
    // host's durable tree budget — so no child ran. Mastra still returns a
    // successful tool call carrying `[Delegation Rejected] …`, which would
    // read as a completion without this discriminator.
    return makeRunEventChunk('subagent.failed', 'failed', 'Subagent delegation rejected', {
      ...metadata,
      outcome: SUBAGENT_REJECTED_OUTCOME,
    });
  }
  if (outcome === SUBAGENT_NO_ANSWER_OUTCOME) {
    // BST-1410. The tool call returned, but the delegation did not do its job:
    // the child wrote no summary, so the parent got tool results nobody
    // analysed. Reporting that as `completed` is the silent success that made
    // the supervisor abandon delegation for a whole turn. `'failed'`, not
    // `'cancelled'`: nothing was cancelled and nobody chose this.
    //
    // `outcome` is the MACHINE-READABLE discriminator. Both this case and a
    // hard child `tool-error` are `subagent.failed`/`failed`, so the card must
    // not have to tell them apart by sniffing the label. It is a bounded enum
    // string, not args or results, so it respects the ids/labels-only rule for
    // subagent metadata.
    return makeRunEventChunk('subagent.failed', 'failed', 'Subagent returned no answer', {
      ...metadata,
      outcome: SUBAGENT_NO_ANSWER_OUTCOME,
    });
  }
  if (outcome === SUBAGENT_TRUNCATED_OUTCOME) {
    // The child hit its durable budget and the model cut its reserved summary.
    // A COMPLETION with partial findings, so `finished`; the discriminator lets
    // the card say "truncated" without sniffing the label.
    return makeRunEventChunk(
      'subagent.finished',
      'completed',
      'Subagent completed with a truncated summary',
      { ...metadata, outcome: SUBAGENT_TRUNCATED_OUTCOME }
    );
  }
  return makeRunEventChunk('subagent.finished', 'completed', 'Subagent completed', metadata);
}

/**
 * A delegation tool-call/result/error/decline part: the generic tool event PLUS
 * a mirrored subagent.* run event, while tracking the delegation's in-flight
 * lifecycle so an aborted run can emit a terminal event for orphans.
 */
export function mapToolLifecyclePart(
  part: unknown,
  toolNames: Map<string, string>,
  lifecycleState: ToolLifecycleState,
  partType: DelegationLifecyclePartType,
  sanitizedNameMap: Map<string, string> | undefined,
  delegationToolPersonas: ReadonlyMap<string, string>
): ProcessStreamPartResult {
  const delegation = resolveDelegationPersona(part, toolNames, delegationToolPersonas);
  const failedResult = Boolean(
    partType === 'tool-result' &&
      delegation?.parentToolCallId &&
      lifecycleState.delegationOutcomes?.failed(
        delegation.parentToolCallId,
        readMastraStreamPartString(part, 'runId')
      )
  );
  const parentToolCallId = delegation?.parentToolCallId;
  const alreadySettled =
    partType !== 'tool-call' &&
    parentToolCallId !== undefined &&
    lifecycleState.terminalToolCallStates.has(parentToolCallId);
  const lifecycleType = failedResult ? 'tool-error' : partType;
  const generic = mapGenericToolEvent(
    failedResult ? { ...asMastraStreamPart(part), type: 'tool-error' } : part,
    toolNames,
    lifecycleState,
    lifecycleType,
    sanitizedNameMap
  );
  if (!delegation) {
    return generic;
  }
  // Mastra may publish a tool-result after a failed delegation's tool-error.
  // The generic timeline already keeps the first terminal; mirror that rule
  // for the paired subagent timeline rather than reporting a second outcome.
  if (alreadySettled) {
    return generic;
  }
  const parentRuntimeRunId = readMastraStreamPartString(part, 'runId');
  const metadata: AssistantRunEventMetadata = {
    ...(parentRuntimeRunId ? { parentRuntimeRunId } : {}),
    personaId: delegation.personaId,
    toolName: delegation.toolName,
    ...(delegation.parentToolCallId ? { parentToolCallId: delegation.parentToolCallId } : {}),
  };
  if (delegation.parentToolCallId) {
    if (partType === 'tool-call') {
      lifecycleState.delegationLifecycle.started(delegation.parentToolCallId, metadata);
    } else {
      lifecycleState.delegationLifecycle.settled(delegation.parentToolCallId);
    }
  }
  const outcome = resolveRecordedDelegationOutcome(
    partType,
    delegation.parentToolCallId,
    parentRuntimeRunId,
    lifecycleState.delegationOutcomes
  );
  return {
    chunks: [...generic.chunks, makeSubagentLifecycleChunk(lifecycleType, metadata, outcome)],
    finished: false,
  };
}
