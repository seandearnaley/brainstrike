/**
 * BST-986: TERMINATION POLICY — what a run emits when it ends abnormally.
 *
 * Four abnormal endings, one shape: flush pending tool-output run-events, emit
 * the human reason as visible assistant text, emit a `run.failed` carrying that
 * same reason as its durable `detail`, then an ERROR finish so the thread
 * reaches a terminal state. Never a throw — a throw produced a data-stream error
 * frame the renderer did not surface, leaving the thread on a forever-spinning
 * step (docs/agents/assistant-runtime.md).
 *
 * WHAT THIS MODULE IS NOT. Provider-error CLASSIFICATION is not here and never
 * was: `../provider-error-metadata.ts` extracts the bounded `runError` envelope
 * and `mastra-chunk-decoding.ts` resolves the visible detail / diagnostic code.
 * The watchdog MECHANISM is not here either — `../stream/with-inactivity-timeout`
 * and `../stream/with-tool-call-input-timeout` own the timers and throw the two
 * errors; this module owns only the policy for what the user and the durable
 * timeline see when one of them fires.
 */
import { createLogger } from '@brainstrike/logging';
import {
  isLocalRunErrorClassification,
  type ProviderRunError,
  providerRunErrorToEventMetadata,
} from '../provider-error-metadata';
import type { AssistantRunEventMetadata } from '../run-events';
import { StreamStalledError } from '../stream/with-inactivity-timeout';
import { ToolCallInputStreamingTimeoutError } from '../stream/with-tool-call-input-timeout';
import type { RuntimeData, StreamChunk } from '../types';
import {
  buildProviderErrorDiagnosticCode,
  buildProviderErrorDiagnosticCorrelation,
  MAX_VISIBLE_PROVIDER_ERROR_CHARS,
  makeStepMetadata,
  type ResolvedTripwire,
  truncateStreamDetail,
} from './mastra-chunk-decoding';
import {
  makeErrorFinishChunk,
  makeRunEventChunk,
  makeRunFailedChunk,
  makeSyntheticFinishChunk,
} from './stream-run-event-chunks';
import {
  makeCancelledDelegationRunEventChunks,
  makePendingToolOutputRunEventChunks,
  makeToolLifecycleRunEventChunk,
  type ProcessStreamPartResult,
  type ToolLifecycleState,
} from './tool-lifecycle-processors';

const logger = createLogger('MastraAgent');

function settleActiveChildTools(state: ToolLifecycleState, cancelled: boolean): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const [toolCallId, active] of state.activeToolEvents ?? []) {
    const tool = {
      name: active.name,
      payload: {
        error: cancelled
          ? 'Tool cancelled with the child run.'
          : 'Tool interrupted before returning a result.',
        toolCallId,
      },
      status: 'error',
      type: 'tool-event',
    } as const;
    const terminal = makeToolLifecycleRunEventChunk(tool, 'tool-error', state);
    chunks.push(tool);
    if (terminal?.type === 'run-event') {
      chunks.push(
        cancelled ? { ...terminal, event: { ...terminal.event, status: 'cancelled' } } : terminal
      );
    }
  }
  return chunks;
}

/** A parent ending must settle every still-open child before its own finish. */
export function makeDelegatedStreamTermination(
  state: ToolLifecycleState,
  cancelled: boolean,
  detail?: string
): StreamChunk[] {
  return [
    ...makeCancelledDelegationRunEventChunks(state),
    ...makePendingToolOutputRunEventChunks(state),
    ...settleActiveChildTools(state, cancelled),
    cancelled
      ? makeRunEventChunk('run.cancelled', 'cancelled', 'Child run cancelled')
      : makeRunFailedChunk(
          'Child stream interrupted',
          detail ?? 'The parent stream ended before the child reported a terminal result.'
        ),
    cancelled ? makeSyntheticFinishChunk() : makeErrorFinishChunk(),
  ];
}

/**
 * Terminate a run gracefully after a provider/model error part.
 *
 * Emits a user-visible assistant message with the reason, flushes any pending
 * tool-output run-events, marks the run `run.failed` (which clears in-flight
 * "started" spinners in the renderer), and finishes with reason `error`. This
 * replaces throwing on the error part: the throw surfaced a data-stream error
 * frame the renderer never rendered, leaving the thread hung on a spinner.
 */
export function makeProviderErrorTermination(
  detail: string,
  lifecycleState: ToolLifecycleState,
  part: unknown,
  runtimeData: RuntimeData | undefined,
  runError: ProviderRunError
): ProcessStreamPartResult {
  // Preserve the server-side breadcrumb. We terminate the run gracefully here
  // (visible message + run.failed) instead of throwing through
  // handleStreamFailure, so without this log the provider failure would be
  // invisible server-side — the `mastra_agent_stream_finished` success line in
  // the finally block would be the only record. Log at error level with a
  // distinct code so these stay diagnosable even though the user sees a clean
  // message. (Per AGENTS.md's observability working rule.) The FULL detail goes to
  // the log; the visible message is clamped below. The message text matches the
  // classification: grepping logs by message must not land local faults on the
  // provider answer.
  logger.error(
    isLocalRunErrorClassification(runError.code)
      ? 'mastra stream terminated by local error'
      : 'mastra stream terminated by provider error',
    {
      code: buildProviderErrorDiagnosticCode(runError),
      detail,
      ...buildProviderErrorDiagnosticCorrelation(runtimeData),
    }
  );
  return makeVisibleRunFailureTermination(
    detail,
    lifecycleState,
    {
      ...makeStepMetadata(part),
      ...providerRunErrorToEventMetadata(runError),
    },
    'The model request failed'
  );
}

export function makeTripwireTermination(
  tripwire: ResolvedTripwire,
  lifecycleState: ToolLifecycleState,
  part: unknown,
  runtimeData: RuntimeData | undefined
): ProcessStreamPartResult {
  // Unlike provider error bodies, processor tripwire reasons and metadata are
  // bounded before both logging and persistence. They may contain selected
  // policy-triggering content, so the diagnostic breadcrumb must stay safe.
  logger.error('mastra stream terminated by tripwire', {
    code: 'mastra_agent_stream_tripwire',
    detail: tripwire.detail,
    tripwire: tripwire.diagnostic,
    ...buildProviderErrorDiagnosticCorrelation(runtimeData),
  });
  return makeVisibleRunFailureTermination(
    tripwire.detail,
    lifecycleState,
    {
      ...makeStepMetadata(part),
      tripwire: tripwire.diagnostic,
    },
    'The request was stopped'
  );
}

function makeVisibleRunFailureTermination(
  detail: string,
  lifecycleState: ToolLifecycleState,
  runMetadata: AssistantRunEventMetadata | undefined,
  messagePrefix: string
): ProcessStreamPartResult {
  // Clamp the user-visible detail: provider error bodies can be arbitrarily long
  // (and occasionally echo request context), which reads poorly as persisted
  // assistant text. Provider errors retain their full detail in the breadcrumb;
  // tripwire reasons arrive here already bounded by their privacy contract.
  const visibleDetail = truncateStreamDetail(detail, MAX_VISIBLE_PROVIDER_ERROR_CHARS);
  return {
    chunks: [
      ...makePendingToolOutputRunEventChunks(lifecycleState),
      { type: 'text-delta', value: `${messagePrefix}: ${visibleDetail}` },
      makeRunFailedChunk('Assistant run failed', visibleDetail, runMetadata),
      makeErrorFinishChunk(),
    ],
    finished: true,
  };
}

function makeStreamStalledTermination(
  error: StreamStalledError,
  lifecycleState: ToolLifecycleState,
  runtimeData: RuntimeData | undefined
): StreamChunk[] {
  const provider = runtimeData?.provider?.trim().toLowerCase();
  const model = runtimeData?.model?.trim();
  const localRuntimeName =
    provider === 'ollama' ? 'Ollama' : provider === 'lmstudio' ? 'LM Studio' : null;
  // BST-1408: `inactivityMs` alone cannot say WHICH silence fired or what the
  // provider was doing when it went quiet, so the 2026-08-22 stall had to be
  // reconstructed by inference from run-event timestamps. `phase` separates
  // "never started answering" from "started, then stopped"; `lastPartType` and
  // `partsSeen` say how far the stream got. All three ride the durable
  // run.failed metadata, so a debug bundle carries them without extra logging.
  const diagnosticContext = {
    inactivityMs: error.inactivityMs,
    partsSeen: error.partsSeen,
    phase: error.phase,
    ...(error.lastPartType ? { lastPartType: error.lastPartType } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
  logger.error(
    {
      code: 'mastra_agent_stream_inactivity_timeout',
      ...diagnosticContext,
    },
    'mastra stream stalled by inactivity timeout'
  );
  // Now that the phase is known, the two silences read differently — and the
  // wording points at the window an operator would actually reach for. A
  // never-started step rendered as "stalled ... without output" implied the
  // model had been streaming and stopped, which is the opposite of what
  // happened (review of #2586).
  const visibleMessage = resolveStalledVisibleMessage(error, localRuntimeName, model);
  return [
    // A stall mid-delegation must never leave an orphaned `subagent.started`
    // with no terminal counterpart — mirror the abort branches' drain.
    ...makeCancelledDelegationRunEventChunks(lifecycleState),
    ...makePendingToolOutputRunEventChunks(lifecycleState),
    {
      type: 'text-delta',
      value: visibleMessage,
    },
    makeRunFailedChunk('Assistant run failed', visibleMessage, {
      code: error.code,
      ...diagnosticContext,
    }),
    makeErrorFinishChunk(),
  ];
}

/**
 * The user-visible stall text. Local runtimes keep their runner-specific
 * remedy; every other provider gets a message that names WHICH silence fired.
 */
function resolveStalledVisibleMessage(
  error: StreamStalledError,
  localRuntimeName: string | null,
  model: string | undefined
): string {
  if (localRuntimeName && model) {
    return `${localRuntimeName} model "${model}" produced no stream output for ${error.inactivityMs}ms. Verify the ${localRuntimeName} server and model runner, then retry.`;
  }
  if (error.phase === 'awaiting-output') {
    return `The model produced no output within ${error.inactivityMs}ms of the request starting.`;
  }
  if (error.phase === 'reasoning') {
    // "stalled without output" would be actively wrong here: the model WAS
    // producing output — reasoning — and then stopped mid-thought. Naming the
    // phase also points at the one setting that changes this outcome.
    return `The model stopped mid-reasoning, producing nothing further for ${error.inactivityMs}ms. Retry, or lower the reasoning effort if it recurs.`;
  }
  return `The model stream stalled after ${error.inactivityMs}ms without output.`;
}

function makeToolCallInputTimeoutTermination(
  error: ToolCallInputStreamingTimeoutError,
  lifecycleState: ToolLifecycleState,
  runtimeData: RuntimeData | undefined
): StreamChunk[] {
  const provider = runtimeData?.provider?.trim().toLowerCase();
  const model = runtimeData?.model?.trim();
  const diagnosticContext = {
    timeoutMs: error.timeoutMs,
    toolCallId: error.toolCallId,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
  logger.error(
    {
      code: 'mastra_agent_tool_call_input_streaming_timeout',
      ...diagnosticContext,
    },
    'mastra tool call input exceeded its streaming deadline'
  );
  return [
    ...makeCancelledDelegationRunEventChunks(lifecycleState),
    ...makePendingToolOutputRunEventChunks(lifecycleState),
    {
      type: 'text-delta',
      value: `The model did not finish streaming a tool call's arguments within ${error.timeoutMs}ms. The incomplete tool call was cancelled before execution.`,
    },
    makeRunFailedChunk(
      'Assistant run failed',
      `The model did not finish streaming a tool call's arguments within ${error.timeoutMs}ms.`,
      { code: error.code, ...diagnosticContext }
    ),
    makeErrorFinishChunk(),
  ];
}

/**
 * A terminal `finish` arrived on a turn whose model contributed NOTHING — no
 * non-empty text delta, no reasoning delta, no tool-lifecycle part, across
 * every attempt of the turn.
 *
 * Field case (2026-08-23, `stealth/ox-alpha`): OpenRouter's anonymous route
 * degraded into returning HTTP 200 streams containing one instant model step
 * with zero usage and a clean `finish`. Mapping that to `run.finished /
 * completed` painted an empty assistant bubble marked "success" — a silent
 * fallback. The same OpenRouter key and prompts were getting real responses
 * from other models minutes earlier, so this is an attempt-level provider
 * fault, and it rides the BST-1409 attempt-recovery rails exactly like a
 * stall: thrown by the mapper's `finish` case, caught by the turn runner,
 * retried up to the stall attempt budget, then terminated visibly.
 */
export class EmptyModelResponseError extends Error {
  readonly code = 'empty_model_response';
  /** The finish reason the empty stream claimed — `stop` in the field case. */
  readonly finishReason: string;
  /** Completed provider steps observed — 1 in the field case, all instant. */
  readonly stepCount: number;

  constructor(finishReason: string, stepCount: number) {
    super(`The model returned an empty response (finish reason "${finishReason}").`);
    this.name = 'EmptyModelResponseError';
    this.finishReason = finishReason;
    this.stepCount = stepCount;
  }
}

function makeEmptyModelResponseTermination(
  error: EmptyModelResponseError,
  lifecycleState: ToolLifecycleState,
  runtimeData: RuntimeData | undefined
): StreamChunk[] {
  const provider = runtimeData?.provider?.trim().toLowerCase();
  const model = runtimeData?.model?.trim();
  const diagnosticContext = {
    finishReason: error.finishReason,
    stepCount: error.stepCount,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
  logger.error(
    { code: 'mastra_agent_empty_model_response', ...diagnosticContext },
    'mastra stream finished without any model output'
  );
  const visibleMessage =
    `The model${model ? ` "${model}"` : ''} returned an empty response — no text, reasoning, ` +
    `or tool calls (finish reason "${error.finishReason}"). The provider route may be ` +
    'degraded; retry, or switch models.';
  return [
    ...makeCancelledDelegationRunEventChunks(lifecycleState),
    ...makePendingToolOutputRunEventChunks(lifecycleState),
    { type: 'text-delta', value: visibleMessage },
    makeRunFailedChunk('Assistant run failed', visibleMessage, {
      code: error.code,
      ...diagnosticContext,
    }),
    makeErrorFinishChunk(),
  ];
}

type StreamWatchdogError =
  | EmptyModelResponseError
  | StreamStalledError
  | ToolCallInputStreamingTimeoutError;

export function isStreamWatchdogError(error: unknown): error is StreamWatchdogError {
  return (
    error instanceof StreamStalledError ||
    error instanceof ToolCallInputStreamingTimeoutError ||
    error instanceof EmptyModelResponseError
  );
}

export function makeStreamWatchdogTermination(
  error: StreamWatchdogError,
  lifecycleState: ToolLifecycleState,
  runtimeData: RuntimeData | undefined
): StreamChunk[] {
  if (error instanceof ToolCallInputStreamingTimeoutError) {
    return makeToolCallInputTimeoutTermination(error, lifecycleState, runtimeData);
  }
  if (error instanceof EmptyModelResponseError) {
    return makeEmptyModelResponseTermination(error, lifecycleState, runtimeData);
  }
  return makeStreamStalledTermination(error, lifecycleState, runtimeData);
}
