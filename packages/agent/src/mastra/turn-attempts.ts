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
import type { Agent, AgentMemoryOption, AgentSignal, MastraDBMessage } from '@mastra/core/agent';
import type { MastraMemory } from '@mastra/core/memory';
import { createMastraAgentError } from '../mastra-boundary/mastra-agent-error';
import { StreamStalledError } from '../stream/with-inactivity-timeout';
import { ToolCallInputStreamingTimeoutError } from '../stream/with-tool-call-input-timeout';
import {
  makeErrorFinishChunk,
  makeRunDetailEventChunk,
  makeRunFailedChunk,
} from '../tool-projection/stream-run-event-chunks';
import type { ToolExecutionDurations } from '../tools/tool-execution-durations';
import type { AgentMessage, RuntimeData, StreamChunk } from '../types';
import {
  type AbortedTurnPersistence,
  createAbortedTurnPersistence,
} from './aborted-turn-persistence';
import type { MastraAgentRuntime } from './agent-runtime';
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
  nativeWake?: {
    readonly signal: AgentSignal;
    readonly maxSteps?: number;
    readonly onWake: (nativeRunId: string) => Promise<void>;
  };
  onNativeStart?: (nativeRunId: string) => Promise<void>;
  requireToolApproval?: boolean;
  runtime: MastraAgentRuntime;
  runtimeData?: RuntimeData;
  sanitizedNameMap?: Map<string, string>;
}
export interface StreamAbortContext {
  abort: (reason: Error) => void;
  dispose: () => Promise<void>;
  signal: AbortSignal;
}

export function createStreamAbortContext(
  externalSignal: AbortSignal | undefined,
  stopOwnedBackground?: (cancelPaused: boolean) => Promise<void>
): StreamAbortContext {
  const controller = new AbortController();
  let backgroundStop: Promise<void> | undefined;
  let closingNormally = false;
  const abortBackground = (): void => {
    backgroundStop ??= stopOwnedBackground?.(!closingNormally);
    // Disposal below joins the original rejection; an event listener cannot await it.
    backgroundStop?.catch(() => {});
  };
  controller.signal.addEventListener('abort', abortBackground, { once: true });
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
        // Attempt/provider/watchdog failure is not an explicit root Stop.
        closingNormally = true;
        controller.abort(reason);
      }
    },
    dispose: async () => {
      externalSignal?.removeEventListener('abort', forwardExternalAbort);
      if (!controller.signal.aborted) {
        closingNormally = true;
        controller.abort(new Error('Mastra stream consumption ended.'));
      }
      controller.signal.removeEventListener('abort', abortBackground);
      await backgroundStop;
    },
    signal: controller.signal,
  };
}
/** Preserve the construction cause while still joining background cleanup. */
export async function disposeStreamAfterFailure(
  context: StreamAbortContext,
  failure: unknown
): Promise<unknown> {
  try {
    await context.dispose();
    return failure;
  } catch (cleanupFailure) {
    return new AggregateError(
      [failure, cleanupFailure],
      'Stream construction and background cleanup failed'
    );
  }
}

/**
 * How long Mastra's native stream may take to close once this runtime has
 * aborted it. The work being joined is Mastra's cancel persistence and two
 * snapshot DELETEs; a stream that ignores its abort (a hung provider socket, a
 * tool that never returns) must not hold the turn's disposal hostage — that is
 * the failure the watchdog exists to contain. Past the deadline the join stops
 * waiting and records a named error; the leaked pipeline is then bounded by
 * the vitest event-loop watchdog and PGlite's fail-closed trap (BST-1221).
 */
export const NATIVE_STREAM_SETTLE_DEADLINE_MS = 30_000;

/**
 * Join Mastra's own consumption of the native stream before the turn ends.
 *
 * On every terminal path the agentic loop awaits `deleteRunSnapshots()` — two
 * `DELETE FROM mastra_workflow_snapshot` statements — before it closes its
 * stream, so a caller that READS the stream to its end never sees them in
 * flight. An attempt abandoned early (watchdog, Stop, `.return()`) never reads
 * that close: without this join the statements float past the end of the turn
 * and race the storage close. PGlite deactivates its backend before draining
 * (BST-1320), the in-flight Bind traps, and the stock loop spins the worker
 * forever (BST-1221; traced 2026-09-12 in
 * `mastra-memory-persistence.integration.spec.ts`). `consumeStream` is
 * idempotent — `MastraModelOutput` memoises one `#consumeStreamPromise` that
 * pumps its base stream, and `fullStream` is an evented view fed by that pump
 * (its first `pull` is what starts it) — and resolves once the base stream has
 * closed, i.e. after that cleanup.
 *
 * Ordering: this runs BEFORE the abort seam's awaited save. Mastra's cancel
 * persistence (`MessageHistory.processOutputResult`) writes inside this
 * window; the seam then captures the list Mastra finished with and appends the
 * abort marker to its last assistant message as an upsert of Mastra's own id,
 * so the marker is the last thing the model reads. Saving first puts the marker
 * on the completed tool-work row and Mastra's later partial-text rows order
 * after it (measured 2026-09-12). By the time this join runs the attempt's
 * abort context has been disposed, so the stream's abort is the expected way it
 * ends; a consumption error here is either that abort or a stream failure the
 * chunk path already surfaced, and is recorded rather than thrown a second
 * time.
 */
export async function settleNativeStream(
  streamResult: {
    consumeStream: (options?: { onError?: (error: unknown) => void }) => Promise<void>;
  },
  streamAbortContext: Pick<StreamAbortContext, 'abort' | 'signal'>,
  options: { readonly deadlineMs?: number } = {}
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? NATIVE_STREAM_SETTLE_DEADLINE_MS;
  // The join is only bounded if the stream has been told to stop: make that
  // structural here instead of trusting every caller's ordering. `abort` is a
  // no-op once the context has already aborted (a normally finished attempt
  // was aborted by its own `dispose()` before this runs).
  const wasAlreadyAborted = streamAbortContext.signal.aborted;
  const settlementAbort = new Error('Native stream settlement started.');
  streamAbortContext.abort(settlementAbort);
  let recorded = false;
  let recordedUnexpected = false;
  const recordConsumptionError = (error: unknown): void => {
    // The abort is the expected way an abandoned stream ends — as the abort
    // reason itself, one `cause` hop away, or as an `AbortError` (which also
    // buckets an unrelated inner abort, a tool's own fetch for instance, as
    // expected; abort-shaped failures do not reach warn). Anything else that
    // surfaces only now — a failing snapshot DELETE, a persistence error in
    // Mastra's cancel write — is a failure the chunk path never saw.
    const reason: unknown = streamAbortContext.signal.reason;
    const expectedEnding =
      error === reason ||
      error === settlementAbort ||
      (error instanceof Error &&
        (error.name === 'AbortError' || error.cause === reason || error.cause === settlementAbort));
    // One failure, one record: a callee that both reports through `onError`
    // and rejects is counted once — but a genuine failure that surfaces AFTER
    // the expected abort record must still reach warn, so the latch only
    // suppresses repeats of what has already been said.
    if (recorded && (expectedEnding || recordedUnexpected)) {
      return;
    }
    recorded = true;
    recordedUnexpected ||= !expectedEnding;
    const record = {
      code: 'mastra_native_stream_settled_with_error',
      error: error instanceof Error ? error.message : String(error),
      wasAlreadyAborted,
    };
    if (expectedEnding) {
      logger.debug(record, 'native Mastra stream ended by its abort while being settled');
      return;
    }
    logger.warn(record, 'native Mastra stream failed while being settled');
  };
  // A `consumeStream` that rejects — or throws synchronously — instead of
  // routing through `onError` is recorded the same way, so the "recorded,
  // never thrown a second time" contract holds structurally rather than
  // depending on the callee.
  const consumption = Promise.resolve()
    .then(() => streamResult.consumeStream({ onError: recordConsumptionError }))
    .catch(recordConsumptionError);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), deadlineMs);
  });
  try {
    const outcome = await Promise.race([consumption.then(() => 'settled' as const), deadline]);
    if (outcome === 'deadline') {
      logger.error(
        { code: 'mastra_native_stream_settle_timeout', deadlineMs },
        'native Mastra stream did not close within the settlement deadline after abort; disposing without it'
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

export type AbandonableNativeStream = Parameters<typeof settleNativeStream>[0];

/**
 * A resume leg that fails after its native output exists owns that stream: it
 * is aborted and read to its close through `settleNativeStream` (bounded, and
 * recording its own failures) before the leg is disposed. Otherwise Mastra's
 * cancel persistence and snapshot DELETEs float past the end of the turn and
 * race the storage close (BST-1221).
 */
export async function settleAbandonedNativeStream(
  stream: AbandonableNativeStream | undefined,
  streamAbortContext: StreamAbortContext
): Promise<void> {
  if (!stream) {
    return;
  }
  await settleNativeStream(stream, streamAbortContext);
}

/** One cleanup boundary joins every owner and keeps primary and cleanup causes. */
export async function settleStreamCleanup(
  owners: readonly (Promise<void> | undefined)[],
  primaryFailure: unknown,
  diagnostics: () => void
): Promise<void> {
  const settled = await Promise.allSettled(owners);
  diagnostics();
  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length === 0) {
    return;
  }
  if (primaryFailure !== undefined) {
    failures.unshift(primaryFailure);
  }
  throw failures.length === 1
    ? failures[0]
    : new AggregateError(failures, 'Stream and background cleanup failed');
}

interface StreamResultLike {
  fullStream?: NodeReadableStream<unknown> | ReadableStream<unknown>;
}

export function createRuntimeAbortedTurnPersistence({
  finalizeAbortedDelegatedTurns,
  memory,
  memoryOption,
  runtimeData,
  streamAbortContext,
}: {
  finalizeAbortedDelegatedTurns?: (() => Promise<void>) | undefined;
  memory: MastraMemory | undefined;
  memoryOption: ResolvedAgentMemoryOption | undefined;
  runtimeData: RuntimeData | undefined;
  streamAbortContext: StreamAbortContext;
}): AbortedTurnPersistence | undefined {
  if (!(memoryOption && memory && runtimeData)) {
    return;
  }
  // Only a `ResolvedAgentMemoryOption` reaches here, and its `options` carry
  // the merged thread config's `readOnly` — the same answer Mastra enforces.
  if (memoryOption.options?.readOnly) {
    return;
  }
  return createAbortedTurnPersistence({
    assistantMessageId: runtimeData.assistantMessageId ?? generateUUID(),
    beforePersist: finalizeAbortedDelegatedTurns,
    memory,
    runtimeData,
    shouldPersist: () =>
      Boolean(runtimeData.signal?.aborted) ||
      isStreamWatchdogError(streamAbortContext.signal.reason),
  });
}

async function finalizeAbortedTurn(
  abortedTurnPersistence: Pick<AbortedTurnPersistence, 'finalize'> | undefined
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

declare const RESOLVED_MEMORY_OPTION: unique symbol;
/**
 * An `AgentMemoryOption` that `resolveMemoryOption` built: its `options`
 * carry `readOnly: true` whenever the merged thread config is read-only (a
 * writable memory leaves the caller's options untouched, so a caller-supplied
 * `readOnly: true` stays as it was). Consumers may therefore read
 * `options?.readOnly === true` as "writes are off" — it is never false when
 * the merged policy is read-only — and the brand keeps a hand-built option
 * from reaching the abort seam, where an unstamped `readOnly` would fail
 * open.
 */
export type ResolvedAgentMemoryOption = AgentMemoryOption & {
  readonly [RESOLVED_MEMORY_OPTION]: true;
};

export function resolveMemoryOption(
  runtimeData: RuntimeData | undefined,
  memory: MastraMemory | undefined
): ResolvedAgentMemoryOption | undefined {
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
  // Mastra's MessageHistory processor and its per-step save read `readOnly`
  // from the REQUEST memory options only, never from the Memory instance's
  // defaults, so a memory whose defaults are read-only would still be written
  // on completion and on cancel. The merged thread config is the effective
  // policy (the abort seam already reads it); carry its `readOnly` onto the
  // request so Mastra enforces the same answer.
  const readOnly = memory.getMergedThreadConfig(memoryContext.memoryOptions ?? {}).readOnly;
  const options = readOnly
    ? { ...memoryContext.memoryOptions, readOnly: true }
    : memoryContext.memoryOptions;
  return {
    resource: memoryContext.resourceId,
    thread: memoryContext.threadId,
    ...(options ? { options } : {}),
  } as ResolvedAgentMemoryOption;
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
  runtimeData:
    | (Pick<RuntimeData, 'provider' | 'steering'> & { memory?: { threadId: string } })
    | undefined,
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
    ...(runtimeData?.memory?.threadId
      ? { toolExecutionThreadId: runtimeData.memory.threadId }
      : {}),
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
  /**
   * Joins Mastra's consumption of this attempt's native stream, including the
   * snapshot cleanup the agentic loop awaits before closing it
   * (`settleNativeStream`). The turn runs it before the abort seam's save and
   * before the runtime is disposed; it is never skipped.
   */
  readonly settleNativeStream: () => Promise<void>;
}

/**
 * Mastra's synchronous `MastraModelOutput.status`. `suspended` at native close
 * means the run is parked on the user: a pause chunk in this leg set it, or a
 * resumed leg restored it from the snapshot because sibling calls stay
 * suspended (that leg closes with no finish and no pause part of its own).
 */
export function readNativeStreamStatus(streamResult: unknown): string | undefined {
  if (typeof streamResult !== 'object' || streamResult === null) {
    return;
  }
  const status = (streamResult as { status?: unknown }).status;
  return typeof status === 'string' ? status : undefined;
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
 * The turn's disposal boundary, in order: join the active attempt's native
 * stream (Mastra's cancel persistence and snapshot cleanup land here), persist
 * the abort snapshot for a user Stop, settle delegated children, dispose the
 * runtime. Every step runs even when an earlier one throws; a single failure
 * propagates as itself and several as an `AggregateError`, so a later step
 * cannot mask an earlier cause.
 */
async function endTurn({
  activeAttempt,
  runtime,
  runtimeData,
  settleAttempt,
}: {
  activeAttempt: TurnAttempt | undefined;
  runtime: MastraAgentRuntime;
  runtimeData: RuntimeData | undefined;
  settleAttempt: (attempt: TurnAttempt) => Promise<void>;
}): Promise<void> {
  const failures: unknown[] = [];
  const step = async (run: () => Promise<void> | undefined): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };
  await step(() => (activeAttempt ? settleAttempt(activeAttempt) : undefined));
  await step(() =>
    runtimeData?.signal?.aborted
      ? finalizeAbortedTurn(activeAttempt?.abortedTurnPersistence)
      : undefined
  );
  await step(() => finalizeAbortedTurn(runtime.delegatedTurnPersistence));
  await step(() => runtime.dispose());
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Turn disposal failed');
  }
}

/**
 * Settles each attempt's native stream exactly once. The turn calls it BEFORE
 * the abort seam saves (see `settleNativeStream` for why that order matters)
 * and `endTurn` catches whichever attempt was active when the turn ended for
 * any other reason.
 */
function createAttemptSettler(): (attempt: TurnAttempt) => Promise<void> {
  // The promise, not a flag, is memoised: a second caller that arrives while
  // the first settle is still in flight joins that same settle instead of
  // being told the attempt is settled already.
  const settling = new WeakMap<TurnAttempt, Promise<void>>();
  return (attempt) => {
    let pending = settling.get(attempt);
    if (!pending) {
      pending = attempt.settleNativeStream();
      settling.set(attempt, pending);
    }
    return pending;
  };
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
  const settleAttempt = createAttemptSettler();
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
          await settleAttempt(current);
          await finalizeAbortedTurn(current.abortedTurnPersistence);
          return;
        }
        stall = error;
      }
      if (!stall) {
        await settleAttempt(current);
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
        stall,
      });
      yield makeStallRunEventChunk(stall, attempt, maxAttempts, reason);
      if (reason) {
        yield* makeStreamWatchdogTermination(stall, current.lifecycleState, runtimeData);
        await settleAttempt(current);
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
      // A recovered root keeps its normal transcript policy, but its cancelled
      // children must finish saving before a new attempt or runtime disposal.
      await settleAttempt(current);
      await finalizeAbortedTurn(runtime.delegatedTurnPersistence);
      continuationMessages = produced;
      carriedLifecycleState = current.lifecycleState;
      lastStalledAttempt = current;
      yield makeResumedRunEventChunk(stall, attempt + 1, maxAttempts, produced?.length ?? 0);
    }
  } finally {
    await endTurn({ activeAttempt, runtime, runtimeData, settleAttempt });
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

/**
 * Whether resuming after this stall is safe to attempt at all, independent of
 * budget or what the attempt produced.
 *
 * A `tool-executing` stall means a tool call started and the stream never saw
 * its settling part (`tool-result` / `tool-error` / …). That is terminal
 * regardless of whether the per-tool execution guard answered fine: hook time
 * (lifecycle hooks around the guarded `execute`) runs inside this phase but
 * OUTSIDE the guard's own window, with no aggregate cap, so the guard can have
 * fired and the call — or its hooks — can still be running. Either way, the
 * process behind that call may still be alive. Recovery re-sends the same step
 * to a continuation, which would launch a SECOND execution of that same tool
 * while the first might still be alive — corrupting whatever the tool does on
 * a second call (writes, side effects, non-idempotent APIs). Every other phase
 * means the MODEL went quiet before or while producing text or reasoning,
 * which a continuation safely restarts from scratch.
 */
function isRecoverableStall(error: EmptyModelResponseError | StreamStalledError): boolean {
  return !(error instanceof StreamStalledError && error.phase === 'tool-executing');
}

/** Why this stall may NOT be recovered, or `undefined` when it may. */
function resolveStallRecoveryRefusal(input: {
  attempt: number;
  lifecycleState: ToolLifecycleState;
  maxAttempts: number;
  produced: readonly MastraDBMessage[] | undefined;
  runtimeData: RuntimeData | undefined;
  stall: EmptyModelResponseError | StreamStalledError;
}): string | undefined {
  if (!isRecoverableStall(input.stall)) {
    return 'tool-still-executing';
  }
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
