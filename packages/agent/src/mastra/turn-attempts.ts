/**
 * Mastra turn/attempt model (BST-1649 split from `agent-streaming.ts`): the
 * attempt/turn abstraction — `TurnAttempt`, `runTurnAttempts`, stall-recovery,
 * the per-attempt lifecycle state, and the abort/memory-persistence plumbing
 * every leg shares.
 *
 * The three leg-specific factories that build ONE Mastra `agent.stream()` /
 * `approveToolCall()`/`declineToolCall()` / `resumeStream()` call apiece live
 * in `attempt-legs.ts` (split further out of this file to respect the
 * per-file line cap) — that module imports `runTurnAttempts` and the other
 * exports here.
 *
 * `streamAttemptChunks` (the per-attempt chunk generator), R6 dispatch, and
 * the public entry points (`streamMastraAgent`,
 * `streamMastraToolApprovalAction`, `streamMastraToolResumeAction`) stay in
 * `agent-streaming.ts`, which imports `attempt-legs.ts`'s entry points
 * (`createStreamIteratorFromRuntime`, `createToolApprovalIteratorFromRuntime`,
 * `createToolResumeIteratorFromRuntime`, the validators, and
 * `readResumedApprovalToolCall`) — and `attempt-legs.ts` imports
 * `streamAttemptChunks` back from `agent-streaming.ts`. `agent-streaming.ts`
 * and `attempt-legs.ts` are mutually dependent by construction (both call
 * into the other); `turn-attempts.ts` itself only depends OUT (never back in
 * from either), which is why it stays under the line cap on its own. Safe in
 * ESM because every reference is inside a function body, never at
 * module-evaluation time.
 *
 * See docs/agents/assistant-runtime.md and docs/agents/mastra-boundary.md.
 */
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { AssistantToolApprovalAction } from '@brainstrike/assistant-contract/tool-approval';
import { createLogger } from '@brainstrike/logging';
import { generateUUID } from '@brainstrike/utils';
import type { Agent, AgentMemoryOption, MastraDBMessage } from '@mastra/core/agent';
import type { MastraMemory } from '@mastra/core/memory';
import type { StreamStalledError } from '../stream/with-inactivity-timeout';
import { ToolCallInputStreamingTimeoutError } from '../stream/with-tool-call-input-timeout';
import type { ToolExecutionDurations } from '../tools/tool-execution-durations';
import type { AgentMessage, RuntimeData, StreamChunk } from '../types';
import {
  type AbortedTurnPersistence,
  createAbortedTurnPersistence,
} from './aborted-turn-persistence';
import type { MastraAgentRuntime } from './agent-runtime';
import { createMastraAgentError } from './mastra-agent-error';
import {
  makeErrorFinishChunk,
  makeRunDetailEventChunk,
  makeRunFailedChunk,
} from './stream-run-event-chunks';
import {
  EmptyModelResponseError,
  isStreamWatchdogError,
  makeStreamWatchdogTermination,
} from './stream-termination';
import {
  createDelegationLifecycleTracker,
  type DelegationOutcomeCapture,
} from './subagent-delegation';
import {
  makeCancelledDelegationRunEventChunks,
  makePendingToolOutputRunEventChunks,
  type ToolLifecycleState,
} from './tool-lifecycle-processors';

const logger = createLogger('MastraAgent');

export interface StreamIterationParams {
  memory?: MastraMemory;
  messages: AgentMessage[];
  requireToolApproval?: boolean;
  runtime: MastraAgentRuntime;
  runtimeData?: RuntimeData;
  sanitizedNameMap?: Map<string, string>;
}
export interface StreamAbortContext {
  abort: (reason: Error) => void;
  dispose: () => void;
  signal: AbortSignal;
}

export function createStreamAbortContext(
  externalSignal: AbortSignal | undefined
): StreamAbortContext {
  const controller = new AbortController();
  const forwardExternalAbort = (): void => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) {
    forwardExternalAbort();
  } else {
    externalSignal?.addEventListener('abort', forwardExternalAbort, { once: true });
  }

  return {
    abort: (reason) => {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    },
    dispose: () => {
      externalSignal?.removeEventListener('abort', forwardExternalAbort);
    },
    signal: controller.signal,
  };
}
interface StreamResultLike {
  fullStream?: NodeReadableStream<unknown> | ReadableStream<unknown>;
}

export function createRuntimeAbortedTurnPersistence({
  memory,
  memoryOption,
  runtimeData,
  streamAbortContext,
}: {
  memory: MastraMemory | undefined;
  memoryOption: AgentMemoryOption | undefined;
  runtimeData: RuntimeData | undefined;
  streamAbortContext: StreamAbortContext;
}): AbortedTurnPersistence | undefined {
  if (!(memoryOption && memory && runtimeData)) {
    return;
  }
  if (memory.getMergedThreadConfig(memoryOption.options).readOnly) {
    return;
  }
  return createAbortedTurnPersistence({
    assistantMessageId: runtimeData.assistantMessageId ?? generateUUID(),
    memory,
    runtimeData,
    shouldPersist: () =>
      Boolean(runtimeData.signal?.aborted) ||
      isStreamWatchdogError(streamAbortContext.signal.reason),
  });
}

async function finalizeAbortedTurn(
  abortedTurnPersistence: AbortedTurnPersistence | undefined
): Promise<void> {
  try {
    await abortedTurnPersistence?.finalize();
  } catch (error) {
    logger.error(
      {
        code: 'mastra_agent_aborted_turn_persist_failed',
        error: error instanceof Error ? error.message : String(error),
      },
      'failed to persist aborted Mastra turn'
    );
  }
}
// Derived from Agent.stream's 2-arg overload (introduced in @mastra/core 1.25 -- the
// 1-arg overload now refuses `undefined` as the second arg, so callers must either
// omit the second arg or pass real options). If a future Mastra bump exposes a
// stable public StreamOptions type, prefer importing that directly over deriving it
// from Parameters<>; the `as AgentStreamOptions` cast at the call sites is what
// keeps this file from reaching across the overload boundary.
export type AgentStreamOptions = Exclude<
  Extract<Parameters<Agent['stream']>, [unknown, unknown]>[1],
  undefined
>;
export type AgentToolApprovalOptions = Parameters<Agent['approveToolCall']>[0];

export interface ToolApprovalIterationParams {
  action: AssistantToolApprovalAction;
  memory?: MastraMemory;
  requireToolApproval?: boolean;
  runtime: MastraAgentRuntime;
  runtimeData?: RuntimeData;
  sanitizedNameMap?: Map<string, string>;
}
export const resolveFullStream = (
  result: unknown
): NodeReadableStream<unknown> | ReadableStream<unknown> | undefined => {
  if (!result || typeof result !== 'object') {
    return;
  }
  return (result as StreamResultLike).fullStream;
};

export function resolveMemoryOption(
  runtimeData: RuntimeData | undefined,
  memory: MastraMemory | undefined
): AgentMemoryOption | undefined {
  const memoryContext = runtimeData?.memory;
  if (!memoryContext) {
    return;
  }
  if (!memory) {
    throw createMastraAgentError('mastra_agent_memory_unavailable', {
      detail: 'runtime memory context was provided but no Mastra memory instance is configured',
    });
  }
  if (!memoryContext.threadId.trim()) {
    throw createMastraAgentError('mastra_agent_memory_unavailable', {
      detail: 'memory.threadId is required',
    });
  }
  if (!memoryContext.resourceId.trim()) {
    throw createMastraAgentError('mastra_agent_memory_unavailable', {
      detail: 'memory.resourceId is required',
    });
  }
  return {
    resource: memoryContext.resourceId,
    thread: memoryContext.threadId,
    ...(memoryContext.memoryOptions ? { options: memoryContext.memoryOptions } : {}),
  };
}
/**
 * Build a {@link ToolLifecycleState} for ONE attempt.
 *
 * The split is deliberate and not uniform (review of #2590):
 *
 * - LATENCY and in-flight lifecycle are per attempt. `streamStartedAtMs`,
 *   `firstTextLatencyMs`, the delegation tracker, and the tool-call maps all
 *   describe one provider call; carrying them would mis-time latency and would
 *   re-settle tools the replaced attempt already settled.
 * - BILLING is per TURN. A recovered turn really did spend the stalled
 *   attempt's tokens, and the `message-finish` this state produces is what the
 *   run ledger and spend analytics persist. Starting the continuation at zero
 *   made every recovered turn under-report, so `carried` seeds those
 *   accumulators from the attempt being replaced.
 */
export function createTurnAttemptLifecycleState(
  runtimeData: Pick<RuntimeData, 'provider' | 'steering'> | undefined,
  delegationOutcomes: DelegationOutcomeCapture | undefined,
  toolExecutionDurations: ToolExecutionDurations | undefined,
  carried?: ToolLifecycleState
): ToolLifecycleState {
  return {
    ...(delegationOutcomes ? { delegationOutcomes } : {}),
    // Prior attempts' totals, added back at the finish. `stepped*` is the
    // replaced attempt's own cumulative sum, so accumulating it here makes this
    // the turn's running total across every attempt so far.
    carriedCompletionTokens:
      (carried?.carriedCompletionTokens ?? 0) + (carried?.steppedCompletionTokens ?? 0),
    carriedPromptTokens: (carried?.carriedPromptTokens ?? 0) + (carried?.steppedPromptTokens ?? 0),
    delegationLifecycle: createDelegationLifecycleTracker(),
    // Carried so the terminal tool run event can state the time `execute`
    // actually ran — the only honest number for an approval-gated call.
    ...(toolExecutionDurations ? { toolExecutionDurations } : {}),
    includeCacheTokenClasses: runtimeData?.provider === 'anthropic',
    outputOnlyToolEvents: new Map(),
    requiresBilledCost: runtimeData?.provider === 'openrouter',
    ...(runtimeData?.steering ? { steering: runtimeData.steering } : {}),
    // Carried like the billing flags below: a continuation of a turn that
    // already produced output must not re-classify that turn as empty at its
    // own finish.
    sawModelContribution: carried?.sawModelContribution ?? false,
    // Billing observations carry: `sawStepBilledCost` in particular gates the
    // OpenRouter "a step omitted its billed cost" throw, and a continuation
    // that forgot the earlier attempt's billed steps would resolve the turn's
    // cost from the final step alone.
    sawStepBilledCost: carried?.sawStepBilledCost ?? false,
    sawStepWithoutBilledCost: carried?.sawStepWithoutBilledCost ?? false,
    // PER ATTEMPT, unlike the billing fields above: the steered finish reports
    // these directly as Mastra's cross-step sum for ONE stream, and the turn's
    // multi-attempt total rides `carried*` instead.
    startedToolCallIds: new Set(),
    stepBilledCostUsd: carried?.stepBilledCostUsd ?? 0,
    stepCount: carried?.stepCount ?? 0,
    steppedCompletionTokens: 0,
    steppedPromptTokens: 0,
    streamStartedAtMs: Date.now(),
    terminalToolCallStates: new Map(),
    warnedUnknownChunkTypes: new Set(),
  };
}

/** One provider attempt within a turn, plus what a continuation would need. */
export interface TurnAttempt {
  readonly abortedTurnPersistence: AbortedTurnPersistence | undefined;
  readonly chunks: AsyncIterableIterator<StreamChunk>;
  readonly lifecycleState: ToolLifecycleState;
  /**
   * The assistant/tool messages this attempt produced, or `undefined` when they
   * could not be read.
   *
   * The distinction is SAFETY-CRITICAL, not cosmetic. `[]` means the attempt
   * genuinely produced nothing — a stall before the first step — so continuing
   * from the original request alone is correct and re-runs nothing.
   * `undefined` means we could not tell, and continuing would re-send the user
   * request as if the turn had never started: every completed tool would run a
   * second time. A turn that cannot prove what it produced must not resume.
   */
  readProducedMessages(): readonly MastraDBMessage[] | undefined;
}

/**
 * Read the assistant/tool messages an attempt produced, from Mastra's own
 * message list on the stream result.
 *
 * Mastra's `mastra_messages` is NOT a usable source here: an aborted stream
 * persists nothing at all (BST-1415, measured — not even the user's message),
 * so the in-memory list is the only record of what the attempt did.
 *
 * Narrowed rather than asserted, and `undefined` on ANY shape surprise: see
 * {@link TurnAttempt.readProducedMessages} for why a wrong answer here would
 * re-execute tools.
 */
export function readAttemptProducedMessages(
  streamResult: unknown
): readonly MastraDBMessage[] | undefined {
  if (typeof streamResult !== 'object' || streamResult === null) {
    return;
  }
  const messageList = (streamResult as { messageList?: unknown }).messageList;
  if (typeof messageList !== 'object' || messageList === null) {
    return;
  }
  const response = (messageList as { get?: { response?: unknown } }).get?.response;
  if (typeof response !== 'object' || response === null) {
    return;
  }
  const db = (response as { db?: unknown }).db;
  if (typeof db !== 'function') {
    return;
  }
  const produced = (db as () => unknown).call(response);
  return Array.isArray(produced) ? (produced as MastraDBMessage[]) : undefined;
}

/**
 * Run ONE turn across up to `maxAttempts` provider attempts, and dispose the
 * runtime exactly once when it ends (BST-1409).
 *
 * A stall ends an ATTEMPT. It ends the TURN only when the budget is spent, the
 * user cancelled, or the attempt cannot prove what it produced. Everything the
 * earlier attempts streamed has already been yielded to the consumer and stays
 * yielded — recovery never rewinds the visible transcript, it only continues it.
 *
 * Recovery is scoped to `StreamStalledError`. A
 * `ToolCallInputStreamingTimeoutError` means the model never finished writing a
 * tool call's arguments, which is a generation fault rather than a silent
 * transport, and re-sending the same prompt has no reason to change it.
 */
export async function* runTurnAttempts(params: {
  /**
   * Built by the caller BEFORE the generator is returned, so a construction
   * failure still rejects the promise `streamMastraAgent` returns. A run
   * rejected before any stream part must surface as a transport rejection the
   * renderer renders as an error block, not as a mid-stream throw
   * (docs/agents/assistant-runtime.md, renderer safety net).
   */
  firstAttempt: TurnAttempt;
  makeContinuation: (input: {
    attempt: number;
    carriedLifecycleState: ToolLifecycleState;
    continuationMessages: readonly MastraDBMessage[] | undefined;
  }) => Promise<TurnAttempt>;
  maxAttempts: number;
  /**
   * Chunks yielded before the turn, from INSIDE this generator's disposal
   * `try`. REQUIRED so every call site states its scope explicitly; the resume
   * legs pass `[]`.
   *
   * They cannot live in a wrapper around this generator. A wrapper cancelled
   * mid-prelude would never delegate here, so this body — and the `finally`
   * that calls `runtime.dispose()` — would never run, while `firstAttempt` is
   * ALREADY a live stream (it is awaited eagerly by the caller). `.return()` on
   * an unstarted generator does not run its body, so wrapper-side cleanup
   * cannot fix it either (PR #2938 review).
   */
  preludeChunks: readonly StreamChunk[];
  runtime: MastraAgentRuntime;
  runtimeData: RuntimeData | undefined;
}): AsyncIterableIterator<StreamChunk> {
  const { firstAttempt, makeContinuation, maxAttempts, preludeChunks, runtime, runtimeData } =
    params;
  let activeAttempt: TurnAttempt | undefined = firstAttempt;
  let lastStalledAttempt: TurnAttempt | undefined;
  try {
    // First, and inside the `finally` above's scope — see `preludeChunks`.
    for (const chunk of preludeChunks) {
      yield chunk;
    }
    let continuationMessages: readonly MastraDBMessage[] | undefined;
    let carriedLifecycleState: ToolLifecycleState | undefined;
    let pending: TurnAttempt | undefined = firstAttempt;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let current: TurnAttempt;
      if (pending) {
        current = pending;
        pending = undefined;
      } else {
        try {
          current = await makeContinuation({
            attempt,
            carriedLifecycleState: carriedLifecycleState as ToolLifecycleState,
            continuationMessages,
          });
        } catch (error) {
          // Every other terminal path in this function yields the visible
          // text + durable `run.failed` + error-finish triple. A continuation
          // failure throwing mid-stream instead would end the turn with no
          // `run.failed` row and no `thread_runs.error` — the one ending whose
          // cause is invisible in the durable timeline.
          await finalizeAbortedTurn(lastStalledAttempt?.abortedTurnPersistence);
          yield* makeContinuationFailureTermination(error, runtimeData);
          return;
        }
      }
      activeAttempt = current;
      let stall: EmptyModelResponseError | StreamStalledError | undefined;
      try {
        // A continuation is a fresh `agent.stream`, so Mastra emits its own
        // `start` part and the mapper turns it into a SECOND `run.started`.
        // One turn starts once: the duplicate is dropped here, and `run.resumed`
        // (emitted immediately before) is what says a new attempt began. Left
        // in, the timeline shows two "Assistant run started" rows for one turn
        // and every started/finished aggregation double-counts recovered runs
        // (review of #2590).
        yield* attempt === 1 ? current.chunks : withoutDuplicateRunStarted(current.chunks);
      } catch (error) {
        if (!isStreamWatchdogError(error)) {
          throw error;
        }
        if (error instanceof ToolCallInputStreamingTimeoutError) {
          yield* makeStreamWatchdogTermination(error, current.lifecycleState, runtimeData);
          await finalizeAbortedTurn(current.abortedTurnPersistence);
          return;
        }
        stall = error;
      }
      if (!stall) {
        await finalizeAbortedTurn(current.abortedTurnPersistence);
        return;
      }
      const produced = current.readProducedMessages();
      const reason = resolveStallRecoveryRefusal({
        attempt,
        lifecycleState: current.lifecycleState,
        maxAttempts,
        produced,
        runtimeData,
      });
      yield makeStallRunEventChunk(stall, attempt, maxAttempts, reason);
      if (reason) {
        yield* makeStreamWatchdogTermination(stall, current.lifecycleState, runtimeData);
        await finalizeAbortedTurn(current.abortedTurnPersistence);
        return;
      }
      // An attempt being replaced still has to SETTLE what it started, exactly
      // as the terminal path does (`makeStreamStalledTermination` drains both):
      // an orphaned `subagent.started` would render a forever-running
      // delegation, and a tool whose only terminal observation was a
      // `tool-output` part would lose its `tool.completed` row and its duration
      // outright, because the continuation treats that tool result as INPUT and
      // never re-emits it. The whole lifecycle state is discarded with the
      // attempt, so this is the last chance to flush either.
      yield* makeCancelledDelegationRunEventChunks(current.lifecycleState);
      yield* makePendingToolOutputRunEventChunks(current.lifecycleState);
      continuationMessages = produced;
      carriedLifecycleState = current.lifecycleState;
      lastStalledAttempt = current;
      yield makeResumedRunEventChunk(stall, attempt + 1, maxAttempts, produced?.length ?? 0);
    }
  } finally {
    try {
      if (runtimeData?.signal?.aborted) {
        await finalizeAbortedTurn(activeAttempt?.abortedTurnPersistence);
      }
    } finally {
      await runtime.dispose();
    }
  }
}

/**
 * Terminal chunks for a continuation that could not be constructed. Mirrors the
 * watchdog terminations' shape so every abnormal ending of a turn looks the same
 * downstream; the shared turn owner disposes the runtime after abort
 * persistence settles.
 */
function* makeContinuationFailureTermination(
  error: unknown,
  runtimeData: RuntimeData | undefined
): Generator<StreamChunk> {
  const detail = error instanceof Error ? error.message : String(error);
  logger.error(
    {
      code: 'mastra_agent_stream_continuation_failed',
      detail,
      ...(runtimeData?.model ? { model: runtimeData.model } : {}),
      ...(runtimeData?.provider ? { provider: runtimeData.provider } : {}),
    },
    'mastra stream continuation could not be constructed'
  );
  const visible = 'The model stream stalled, and the continuation could not be started.';
  yield { type: 'text-delta', value: visible };
  yield makeRunFailedChunk('Assistant run failed', visible, {
    code: 'mastra_agent_stream_continuation_failed',
  });
  yield makeErrorFinishChunk();
}

/**
 * Drop the `run.started` a continuation attempt re-emits. See its call site for
 * why one turn must report one start.
 */
async function* withoutDuplicateRunStarted(
  chunks: AsyncIterableIterator<StreamChunk>
): AsyncIterableIterator<StreamChunk> {
  let dropped = false;
  for await (const chunk of chunks) {
    if (!dropped && chunk.type === 'run-event' && chunk.event.kind === 'run.started') {
      dropped = true;
      continue;
    }
    yield chunk;
  }
}

/** Why this stall may NOT be recovered, or `undefined` when it may. */
function resolveStallRecoveryRefusal(input: {
  attempt: number;
  lifecycleState: ToolLifecycleState;
  maxAttempts: number;
  produced: readonly MastraDBMessage[] | undefined;
  runtimeData: RuntimeData | undefined;
}): string | undefined {
  if (input.runtimeData?.signal?.aborted) {
    // A user Stop is a decision, not a transport fault.
    return 'cancelled';
  }
  if (input.attempt >= input.maxAttempts) {
    return 'budget-exhausted';
  }
  if (input.produced === undefined) {
    return 'produced-messages-unreadable';
  }
  // CORROBORATION, not paranoia (review of #2590). `[]` is trusted to mean "the
  // attempt produced nothing", which makes continuing from the request alone
  // safe. But that trust rests entirely on the reader, and the attempt holds
  // INDEPENDENT evidence of what it did: `terminalToolCallStates` gains an entry
  // on every completed tool call. An empty message list while tools demonstrably
  // ran is a contradiction — whatever the cause, resuming on it would re-execute
  // every one of those tools, which is the exact outcome the `undefined` branch
  // exists to prevent, reached through the branch treated as safe.
  if (input.produced.length === 0 && input.lifecycleState.terminalToolCallStates.size > 0) {
    return 'produced-messages-contradict-completed-tools';
  }
  return;
}

function makeStallRunEventChunk(
  error: EmptyModelResponseError | StreamStalledError,
  attempt: number,
  maxAttempts: number,
  refusal: string | undefined
): StreamChunk {
  if (error instanceof EmptyModelResponseError) {
    // Same recoverable-attempt-fault shape as a stall (`run.stalled` is the
    // durable "this attempt died, the turn may yet recover" row), but the
    // detail and code say WHICH fault: the provider answered instantly with
    // nothing, rather than going quiet.
    const emptyDetail = `Model returned an empty response (finish reason "${error.finishReason}") on attempt ${attempt} of ${maxAttempts}.`;
    const emptyDiagnostic = {
      attempt,
      code: error.code,
      finishReason: error.finishReason,
      maxAttempts,
      stepCount: error.stepCount,
      ...(refusal ? { refusal } : {}),
    };
    logger.warn(
      { ...emptyDiagnostic, code: 'mastra_agent_stream_attempt_empty' },
      'mastra stream attempt returned an empty response'
    );
    return makeRunDetailEventChunk(
      'run.stalled',
      'info',
      'Model returned an empty response',
      emptyDetail,
      emptyDiagnostic
    );
  }
  const detail = `No stream output for ${error.inactivityMs}ms (${error.phase}) on attempt ${attempt} of ${maxAttempts}.`;
  // A RECOVERED stall is followed by no `run.failed`, so this event is the only
  // durable record of it — it must therefore carry the full BST-1408 breadcrumb,
  // not a subset (review of #2590). `lastPartType` is the field that says
  // whether the provider went quiet after reasoning, a tool delta, or the
  // framework prologue.
  const diagnostic = {
    attempt,
    inactivityMs: error.inactivityMs,
    maxAttempts,
    partsSeen: error.partsSeen,
    phase: error.phase,
    ...(error.lastPartType ? { lastPartType: error.lastPartType } : {}),
    ...(refusal ? { refusal } : {}),
  };
  logger.warn(
    { code: 'mastra_agent_stream_attempt_stalled', ...diagnostic },
    'mastra stream attempt stalled'
  );
  return makeRunDetailEventChunk('run.stalled', 'info', 'Model stream stalled', detail, diagnostic);
}

/**
 * `error` names WHICH fault is being recovered from. The `run.stalled` /
 * `run.resumed` pair is the only durable record of a recovered attempt — the
 * text a debug bundle shows — so a fixed "Continuing after a stall" would
 * report a stall that never happened on the empty-response path (review of
 * #2624).
 */
function makeResumedRunEventChunk(
  error: EmptyModelResponseError | StreamStalledError,
  attempt: number,
  maxAttempts: number,
  carriedMessages: number
): StreamChunk {
  return makeRunDetailEventChunk(
    'run.resumed',
    'info',
    error instanceof EmptyModelResponseError
      ? 'Continuing after an empty response'
      : 'Continuing after a stall',
    `Attempt ${attempt} of ${maxAttempts}, carrying ${carriedMessages} completed message${carriedMessages === 1 ? '' : 's'} forward.`,
    { attempt, carriedMessages, maxAttempts }
  );
}
