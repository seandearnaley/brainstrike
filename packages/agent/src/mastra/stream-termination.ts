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
import { makeErrorFinishChunk, makeRunFailedChunk } from './stream-run-event-chunks';
import {
  makeCancelledDelegationRunEventChunks,
  makePendingToolOutputRunEventChunks,
  type ProcessStreamPartResult,
  type ToolLifecycleState,
} from './tool-lifecycle-processors';

const logger = createLogger('MastraAgent');

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
  const diagnosticContext = {
    inactivityMs: error.inactivityMs,
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
  const visibleMessage =
    localRuntimeName && model
      ? `${localRuntimeName} model "${model}" produced no stream output for ${error.inactivityMs}ms. Verify the ${localRuntimeName} server and model runner, then retry.`
      : `The model stream stalled after ${error.inactivityMs}ms without output.`;
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

type StreamWatchdogError = StreamStalledError | ToolCallInputStreamingTimeoutError;

export function isStreamWatchdogError(error: unknown): error is StreamWatchdogError {
  return error instanceof StreamStalledError || error instanceof ToolCallInputStreamingTimeoutError;
}

export function makeStreamWatchdogTermination(
  error: StreamWatchdogError,
  lifecycleState: ToolLifecycleState,
  runtimeData: RuntimeData | undefined
): StreamChunk[] {
  if (error instanceof ToolCallInputStreamingTimeoutError) {
    return makeToolCallInputTimeoutTermination(error, lifecycleState, runtimeData);
  }
  return makeStreamStalledTermination(error, lifecycleState, runtimeData);
}
