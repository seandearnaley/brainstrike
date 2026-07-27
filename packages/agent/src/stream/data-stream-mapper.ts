import { CONTEXT_BREAKDOWN_DATA_NAME } from '@brainstrike/assistant-contract/context-breakdown';
import { SHELL_OUTPUT_DATA_NAME } from '@brainstrike/assistant-contract/shell-output';
import {
  type AssistantToolApprovalRequest,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  type AssistantToolSuspendRequest,
  TOOL_SUSPEND_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-suspend';
import { createLogger } from '@brainstrike/utils';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '../run-events';
import type {
  StreamChunk,
  StreamChunkContextBreakdown,
  StreamChunkFinish,
  StreamChunkMessageFinish,
  StreamChunkReasoning,
  StreamChunkRunEvent,
  StreamChunkShellOutput,
  StreamChunkText,
  StreamChunkTool,
  StreamChunkToolApprovalRequired,
  StreamChunkToolSuspendRequired,
  StreamFinishReason,
} from '../types';
import { DataStreamCode, type EncodedChunk } from './data-stream-codes';
import { formatDiagnosticChunkType } from './diagnostic-chunk-type';
import { toJsonSafe } from './json';
import { boundToolOutputForModel, readToolOutputErrorText } from './tool-output-limits';

interface ToolState {
  argsEmitted: boolean;
  lastInput?: unknown;
  pendingArgsText: string;
  toolName: string;
}

interface StepState {
  finishReason: StreamFinishReason;
  id: string;
  index: number;
  status: 'success' | 'error';
  usage: DataStreamUsage;
}

interface DataStreamUsage {
  /** Anthropic prompt-cache write tokens; present only when reported. */
  cacheCreationInputTokens?: number;
  /** Anthropic prompt-cache read tokens; present only when reported. */
  cacheReadInputTokens?: number;
  /** Latest provider-step prompt size; the aggregate inputTokens remains billable usage. */
  contextInputTokens?: number;
  /** Latest provider-step completion size; aggregate outputTokens remains billable usage. */
  contextOutputTokens?: number;
  inputTokens: number;
  outputTokens: number;
}

export interface DataStreamTerminalOutcome {
  readonly error: string | null;
  readonly status: 'completed' | 'failed';
}

const RUN_FAILURE_VISIBLE_PREFIX = "I couldn't complete the assistant response:";
const MISSING_FINISH_ERROR_TEXT = 'Assistant stream ended without a normal stop signal.';
/**
 * Durable failure text for an error finish that carried no more specific
 * signal. An error finish is always terminal, so the outcome must never fall
 * through to `completed` merely because no message was attached.
 */
const ERROR_FINISH_FALLBACK_TEXT = 'Assistant run failed.';
const TOOL_ACTION_FAILURE_VISIBLE_PREFIX = "I couldn't complete the tool action because it failed:";
const TOOL_ACTIONS_FAILURE_VISIBLE_PREFIX =
  "I couldn't complete some tool actions because they failed:";
const logger = createLogger('DataStreamMapper');

function formatVisibleFailure(prefix: string, errorText: string): string {
  return `${prefix} ${errorText}`;
}

function formatToolActionFailure(errors: readonly string[]): string {
  if (errors.length === 1) {
    return formatVisibleFailure(
      TOOL_ACTION_FAILURE_VISIBLE_PREFIX,
      errors[0] ?? 'Tool execution failed'
    );
  }
  return formatVisibleFailure(TOOL_ACTIONS_FAILURE_VISIBLE_PREFIX, errors.join('; '));
}

function toDataStreamUsage(raw?: {
  cacheCreationInputTokens?: unknown;
  cacheReadInputTokens?: unknown;
  completionTokens?: unknown;
  contextInputTokens?: unknown;
  contextOutputTokens?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  promptTokens?: unknown;
}): DataStreamUsage {
  const inputTokensRaw = raw?.inputTokens ?? raw?.promptTokens;
  const inputTokens =
    typeof inputTokensRaw === 'number' && Number.isFinite(inputTokensRaw) ? inputTokensRaw : 0;
  const outputTokensRaw = raw?.outputTokens ?? raw?.completionTokens;
  const outputTokens =
    typeof outputTokensRaw === 'number' && Number.isFinite(outputTokensRaw) ? outputTokensRaw : 0;
  const cacheCreationInputTokens =
    typeof raw?.cacheCreationInputTokens === 'number' &&
    Number.isFinite(raw.cacheCreationInputTokens) &&
    raw.cacheCreationInputTokens > 0
      ? raw.cacheCreationInputTokens
      : undefined;
  const cacheReadInputTokens =
    typeof raw?.cacheReadInputTokens === 'number' &&
    Number.isFinite(raw.cacheReadInputTokens) &&
    raw.cacheReadInputTokens > 0
      ? raw.cacheReadInputTokens
      : undefined;
  const contextInputTokens =
    typeof raw?.contextInputTokens === 'number' &&
    Number.isFinite(raw.contextInputTokens) &&
    raw.contextInputTokens >= 0
      ? raw.contextInputTokens
      : undefined;
  const contextOutputTokens =
    typeof raw?.contextOutputTokens === 'number' &&
    Number.isFinite(raw.contextOutputTokens) &&
    raw.contextOutputTokens >= 0
      ? raw.contextOutputTokens
      : undefined;
  return {
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(contextInputTokens === undefined ? {} : { contextInputTokens }),
    ...(contextOutputTokens === undefined ? {} : { contextOutputTokens }),
    inputTokens,
    outputTokens,
  };
}

function sanitizeDelta(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return;
  }
  if (value.length === 0) {
    return;
  }
  return value;
}

function sanitizeToolCallId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return;
}

function extractFinishUsage(chunk: StreamChunkFinish | StreamChunkMessageFinish): DataStreamUsage {
  const usage = (
    chunk as {
      usage?: {
        cacheCreationInputTokens?: unknown;
        cacheReadInputTokens?: unknown;
        completionTokens?: unknown;
        contextInputTokens?: unknown;
        contextOutputTokens?: unknown;
        inputTokens?: unknown;
        outputTokens?: unknown;
        promptTokens?: unknown;
      };
    }
  ).usage;
  return toDataStreamUsage(usage ?? {});
}

function resolveFinishReason(
  chunk: StreamChunkFinish | StreamChunkMessageFinish
): StreamFinishReason {
  const reason = (chunk as { finishReason?: unknown }).finishReason;
  if (typeof reason !== 'string') {
    return 'unknown';
  }
  switch (reason) {
    case 'stop':
    case 'length':
    case 'content-filter':
      return reason;
    case 'tool-calls':
    case 'tool_calls':
      return 'tool-calls';
    case 'error':
    case 'other':
    case 'unknown':
      return reason;
    default:
      return 'unknown';
  }
}

function getAbnormalFinishMessage(reason: StreamFinishReason): string | undefined {
  switch (reason) {
    case 'length':
      return 'Assistant stopped because the model reached its output token limit before completing the response.';
    case 'content-filter':
      return 'Assistant stopped because the provider content filter ended the response.';
    case 'other':
      return 'Assistant stream ended without a normal stop signal.';
    case 'stop':
    case 'tool-calls':
    case 'error':
    case 'unknown':
      return;
    default:
      return;
  }
}

function extractToolInput(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const record = payload as Record<string, unknown>;
  if (record['input'] !== undefined) {
    return toJsonSafe(record['input']);
  }
  if (record['args'] !== undefined) {
    return toJsonSafe(record['args']);
  }
  return;
}

function hasNonEmptyToolInput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  return value !== undefined && value !== null;
}

function readProgressStep(payload: unknown): string | undefined {
  const stepValue = (payload as { step?: unknown })?.step;
  return typeof stepValue === 'string' ? stepValue : undefined;
}

function toArgsObject(value: unknown, fallbackText?: string): unknown {
  if (value && typeof value === 'object') {
    return toJsonSafe(value);
  }
  const text = typeof value === 'string' ? value : fallbackText;
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export class DataStreamMapper {
  private readonly messageId: string;
  private readonly toolState = new Map<string, ToolState>();
  /**
   * Tool calls whose result/error already settled on the wire. Late events for
   * these ids must never resurrect the call through the out-of-order
   * auto-start (a duplicate `b` frame throws in the renderer decoder) or emit
   * further args deltas (the renderer closed that call's argsText on `9`).
   * Bounded by the number of tool calls in one stream (session-lived).
   */
  private readonly settledToolCallIds = new Set<string>();
  private currentStep: StepState | null = null;
  private nextStepIndex = 0;
  private finishEmitted = false;
  private hasVisibleText = false;
  private pendingRunErrorText: string | null = null;
  /**
   * Label of the most recent `run.failed` run event, used as the durable
   * failure text for an error finish. The termination helpers emit the human
   * detail as a visible text-delta (already part of the message content), so
   * the run event's label is the closest thing to a structured reason the
   * mapper can see without reaching into assistant text.
   */
  private runFailedEventText: string | null = null;
  private terminalFailureText: string | null = null;
  private readonly pendingToolErrorTexts = new Map<string, string>();
  private startNewStepForNextText = false;
  private readonly warnedUnknownChunkTypes = new Set<string>();
  /**
   * True while a text/reasoning part is streaming. Data parts emitted while a
   * part is open CLOSE it downstream (assistant-stream's appendData ends the
   * active append), slicing visible text into fragments. Run events that
   * arrive mid-part are deferred to pendingRunEventChunks and flushed at the
   * next natural boundary (tool start, approval, finish, stream end).
   */
  private streamingPartOpen = false;
  private pendingRunEventChunks: EncodedChunk[] = [];

  constructor(messageId: string) {
    this.messageId = messageId;
  }

  initialChunks(): EncodedChunk[] {
    return [...this.startStepIfNeeded()];
  }

  *handleChunk(chunk: StreamChunk): Generator<EncodedChunk> {
    if (this.finishEmitted) {
      return;
    }

    switch (chunk.type) {
      case 'text-delta':
        yield* this.handleTextDelta(chunk);
        return;
      case 'reasoning-delta':
        yield* this.handleReasoningDelta(chunk);
        return;
      case 'run-event':
        yield* this.handleRunEvent(chunk);
        return;
      case 'shell-output':
        yield* this.handleShellOutput(chunk);
        return;
      case 'context-breakdown':
        yield* this.handleContextBreakdown(chunk);
        return;
      case 'tool-event':
        yield* this.handleToolEvent(chunk);
        return;
      case 'tool-approval-required':
        yield* this.handleToolApprovalRequired(chunk);
        return;
      case 'tool-suspend-required':
        yield* this.handleToolSuspendRequired(chunk);
        return;
      case 'finish':
      case 'message-finish':
        yield* this.handleFinish(chunk);
        return;
      default: {
        const rawChunkType = (chunk as { type?: unknown }).type;
        const warningKey = typeof rawChunkType === 'string' ? rawChunkType : '<non-string>';
        if (this.warnedUnknownChunkTypes.has(warningKey)) {
          return;
        }
        this.warnedUnknownChunkTypes.add(warningKey);
        logger.warn('data stream mapper received an unrecognized chunk', {
          chunkType: formatDiagnosticChunkType(rawChunkType),
          code: 'data_stream_mapper_unrecognized_chunk',
        });
        return;
      }
    }
  }

  *handleError(error: unknown): Generator<EncodedChunk> {
    const errorText = error instanceof Error ? error.message : String(error);
    this.terminalFailureText = errorText;
    this.markCurrentStepAsError();
    yield { code: DataStreamCode.error, value: errorText } satisfies EncodedChunk;
    yield* this.flushPendingRunEvents();
    yield* this.finalizeCurrentStep();
    if (!this.finishEmitted) {
      const usage = this.currentStep?.usage ?? toDataStreamUsage();
      yield {
        code: DataStreamCode.finishMessage,
        value: {
          finishReason: 'error',
          path: [],
          usage,
        },
      } satisfies EncodedChunk;
      this.finishEmitted = true;
    }
  }

  finalizeOnStreamEnd(): EncodedChunk[] {
    if (this.finishEmitted) {
      return [];
    }
    const chunks: EncodedChunk[] = [];
    this.pendingRunErrorText = MISSING_FINISH_ERROR_TEXT;
    this.terminalFailureText = MISSING_FINISH_ERROR_TEXT;
    this.markCurrentStepAsError();
    chunks.push({
      code: DataStreamCode.error,
      value: MISSING_FINISH_ERROR_TEXT,
    });
    chunks.push(...this.flushPendingRunEvents());
    chunks.push(...this.emitVisibleFallbackIfNeeded());
    chunks.push(...this.emitPendingToolErrorFallbackIfNeeded());
    const stepBeforeFinalize = this.currentStep;
    chunks.push(...this.finalizeCurrentStep());
    const usage = stepBeforeFinalize?.usage ?? toDataStreamUsage();
    chunks.push({
      code: DataStreamCode.finishMessage,
      value: {
        finishReason: 'error',
        path: [],
        usage,
      },
    });
    this.finishEmitted = true;
    return chunks;
  }

  didEmitFinish(): boolean {
    return this.finishEmitted;
  }

  getTerminalOutcome(): DataStreamTerminalOutcome {
    return this.terminalFailureText
      ? { error: this.terminalFailureText, status: 'failed' }
      : { error: null, status: 'completed' };
  }

  private *handleTextDelta(chunk: StreamChunkText): Generator<EncodedChunk> {
    const delta = sanitizeDelta(chunk.value);
    if (!delta) {
      return;
    }
    if (this.startNewStepForNextText) {
      yield* this.finalizeCurrentStep();
      yield* this.startStepIfNeeded(true);
      this.startNewStepForNextText = false;
    } else {
      yield* this.startStepIfNeeded();
    }
    // If the model continues with visible text after a tool error, treat that
    // as model-owned recovery. The emitted tool-result chunk still carries the
    // structured isError result for UI retry/error affordances.
    this.pendingToolErrorTexts.clear();
    this.hasVisibleText = true;
    this.streamingPartOpen = true;
    yield { code: DataStreamCode.textDelta, value: delta } satisfies EncodedChunk;
  }

  private *handleReasoningDelta(chunk: StreamChunkReasoning): Generator<EncodedChunk> {
    const delta = sanitizeDelta(chunk.value);
    if (!delta) {
      return;
    }
    yield* this.startStepIfNeeded();
    this.streamingPartOpen = true;
    yield { code: DataStreamCode.reasoningDelta, value: delta } satisfies EncodedChunk;
  }

  private *handleRunEvent(chunk: StreamChunkRunEvent): Generator<EncodedChunk> {
    if (chunk.event.kind === 'run.failed') {
      // Prefer `detail` over `label`: all three stream terminations use the same
      // generic label ("Assistant run failed"), so the label alone would persist
      // a signal-free string into `thread_runs.error` — correct status, useless
      // forensics. `detail` carries the specific reason (clamped provider text,
      // the stall's inactivity window, the tool-input timeout). Falls back to
      // the label for run.failed events that carry no detail, such as the
      // unsupported approval/suspend pause.
      this.runFailedEventText = chunk.event.detail ?? chunk.event.label;
    }
    const encoded = {
      code: DataStreamCode.auiDataPart,
      value: {
        data: toJsonSafe(chunk.event),
        name: ASSISTANT_RUN_EVENT_DATA_NAME,
      },
    } satisfies EncodedChunk;
    if (this.streamingPartOpen) {
      this.pendingRunEventChunks.push(encoded);
      return;
    }
    yield encoded;
  }

  /**
   * Emit a live shell-output slice as a transient `aui-data` part. Subject to
   * the SAME text-part deferral contract as run events: a data part emitted mid
   * text/reasoning append would slice visible text, so while a part is open the
   * encoded slice is queued and flushed at the next natural boundary. Shell
   * output is produced during tool execution (after the text turn's finish), so
   * in practice it streams live; the deferral only guards the rare interleave.
   */
  private *handleShellOutput(chunk: StreamChunkShellOutput): Generator<EncodedChunk> {
    const encoded = {
      code: DataStreamCode.auiDataPart,
      value: {
        data: {
          chunk: chunk.chunk,
          stream: chunk.stream,
          toolCallId: chunk.toolCallId,
          ...(chunk.truncated ? { truncated: true } : {}),
        },
        name: SHELL_OUTPUT_DATA_NAME,
      },
    } satisfies EncodedChunk;
    if (this.streamingPartOpen) {
      this.pendingRunEventChunks.push(encoded);
      return;
    }
    yield encoded;
  }

  /**
   * Emit the run-start prompt breakdown as a transient `aui-data` part. Subject
   * to the SAME text-part deferral contract as run events / shell output: a
   * data part emitted mid text/reasoning append would slice visible text, so
   * while a part is open the encoded part is queued and flushed at the next
   * natural boundary. In practice the breakdown is emitted before the first
   * model token, so it streams immediately; the deferral only guards reordered
   * interleaves.
   */
  private *handleContextBreakdown(chunk: StreamChunkContextBreakdown): Generator<EncodedChunk> {
    const encoded = {
      code: DataStreamCode.auiDataPart,
      value: {
        data: toJsonSafe(chunk.breakdown),
        name: CONTEXT_BREAKDOWN_DATA_NAME,
      },
    } satisfies EncodedChunk;
    if (this.streamingPartOpen) {
      this.pendingRunEventChunks.push(encoded);
      return;
    }
    yield encoded;
  }

  private *flushPendingRunEvents(): Generator<EncodedChunk> {
    this.streamingPartOpen = false;
    if (this.pendingRunEventChunks.length === 0) {
      return;
    }
    const pending = this.pendingRunEventChunks;
    this.pendingRunEventChunks = [];
    yield* pending;
  }

  private *handleToolEvent(chunk: StreamChunkTool): Generator<EncodedChunk> {
    const callId = sanitizeToolCallId(
      (chunk.payload as { toolCallId?: unknown; callId?: unknown })?.toolCallId ??
        (chunk.payload as { toolCallId?: unknown; callId?: unknown })?.callId
    );
    if (!callId) {
      return;
    }
    const toolName = chunk.name;
    if (this.settledToolCallIds.has(callId)) {
      // ANY trailing event for an already-settled call (GLM-5.2 via
      // OpenRouter emits trailing deltas; a duplicate start/success/error is
      // the same class): re-emitting would put a duplicate `b` on the wire
      // (the renderer decoder throws on duplicate tool call ids) or a second
      // result/args frame against a closed controller, failing the whole run.
      logger.debug('Dropping tool event for a settled tool call', {
        status: chunk.status,
        toolCallId: callId,
      });
      return;
    }

    if (chunk.status === 'start') {
      const existingState = this.toolState.get(callId);
      if (existingState) {
        const nextInput = extractToolInput(chunk.payload);
        if (
          nextInput !== undefined &&
          !(hasNonEmptyToolInput(existingState.lastInput) && !hasNonEmptyToolInput(nextInput))
        ) {
          existingState.lastInput = nextInput;
        }
        return;
      }
      yield* this.handleToolStart(toolName, callId, chunk.payload);
      return;
    }

    if (!this.toolState.has(callId)) {
      yield* this.handleToolStart(toolName, callId, chunk.payload);
    }

    switch (chunk.status) {
      case 'progress':
        yield* this.handleToolProgress(callId, chunk.payload);
        break;
      case 'success':
        yield* this.handleToolSuccess(toolName, callId, chunk.payload);
        break;
      case 'error':
        yield* this.handleToolError(callId, chunk.payload);
        break;
      default:
        break;
    }
  }

  private *handleToolApprovalRequired(
    chunk: StreamChunkToolApprovalRequired
  ): Generator<EncodedChunk> {
    const callId = sanitizeToolCallId(chunk.toolCallId);
    if (!callId) {
      return;
    }
    yield* this.flushPendingRunEvents();

    if (!this.toolState.has(callId)) {
      yield* this.handleToolStart(chunk.toolName, callId, {
        args: chunk.args,
        input: chunk.args,
      });
    }

    const state = this.toolState.get(callId);
    const args = chunk.args ?? state?.lastInput;
    if (state && !state.argsEmitted) {
      state.argsEmitted = true;
      yield {
        code: DataStreamCode.toolCall,
        value: {
          args: toArgsObject(args, state.pendingArgsText),
          toolCallId: callId,
          toolName: state.toolName,
        },
      } satisfies EncodedChunk;
    }

    const data: AssistantToolApprovalRequest = {
      runId: chunk.runId,
      toolCallId: callId,
      toolName: chunk.toolName,
      ...(chunk.riskCategory === undefined ? {} : { riskCategory: chunk.riskCategory }),
      ...(chunk.policyDecision === undefined ? {} : { policyDecision: chunk.policyDecision }),
      ...(args === undefined ? {} : { args: toJsonSafe(args) }),
      ...(chunk.resumeSchema === undefined ? {} : { resumeSchema: toJsonSafe(chunk.resumeSchema) }),
    };
    yield {
      code: DataStreamCode.auiDataPart,
      value: {
        data,
        name: TOOL_APPROVAL_DATA_NAME,
      },
    } satisfies EncodedChunk;
  }

  private *handleToolSuspendRequired(
    chunk: StreamChunkToolSuspendRequired
  ): Generator<EncodedChunk> {
    const callId = sanitizeToolCallId(chunk.toolCallId);
    if (!callId) {
      return;
    }
    // DEFENSIVE, not load-bearing. This line was added (#1606, @mastra/core
    // 1.50) when Mastra reported suspend() through the tool-error path before
    // the correlated suspension event; the pause is intentional, so only that
    // call's transient error is discarded and unrelated tool failures survive.
    // On @mastra/core 1.51 that ordering no longer occurs — a real suspend
    // emits no tool-error at all, pinned by the live-loop assertions in
    // mastra-tool-suspend-resume.integration.spec.ts ("an UNREGISTERED
    // suspending tool records tool.resume.unsupported and NEVER tool.failed").
    // Kept so a Mastra bump that reinstates the ordering cannot resurface a
    // false "tool failed" message; do NOT cite it as evidence of current
    // behaviour (a PR #1977 review round did, and was wrong).
    this.pendingToolErrorTexts.delete(callId);
    // Text-part deferral contract: finalize any open text/reasoning append and
    // flush deferred run events BEFORE emitting the data part (a data part
    // mid-text slices visible text).
    yield* this.flushPendingRunEvents();

    if (!this.toolState.has(callId)) {
      yield* this.handleToolStart(chunk.toolName, callId, {});
    }

    // Emit the tool-call args part (if not yet emitted) so assistant-ui shows the
    // tool invocation the plan/question belongs to. The suspend payload is the
    // pause data, not the tool input, so args default to the recorded input.
    const state = this.toolState.get(callId);
    if (state && !state.argsEmitted) {
      state.argsEmitted = true;
      yield {
        code: DataStreamCode.toolCall,
        value: {
          args: toArgsObject(state.lastInput, state.pendingArgsText),
          toolCallId: callId,
          toolName: state.toolName,
        },
      } satisfies EncodedChunk;
    }

    const data: AssistantToolSuspendRequest = {
      runId: chunk.runId,
      toolCallId: callId,
      toolName: chunk.toolName,
      ...(chunk.suspendPayload === undefined
        ? {}
        : { suspendPayload: toJsonSafe(chunk.suspendPayload) }),
      ...(chunk.resumeSchema === undefined ? {} : { resumeSchema: toJsonSafe(chunk.resumeSchema) }),
    };
    yield {
      code: DataStreamCode.auiDataPart,
      value: {
        data,
        name: TOOL_SUSPEND_DATA_NAME,
      },
    } satisfies EncodedChunk;

    if (chunk.resumeSupported === false) {
      // BST-558: this build has no registered resume UI for the tool, so nothing
      // will ever produce this call's result. Leaving it open would keep a
      // Running ToolFallback forever — and the notice above is dismissible, so a
      // dismissed notice would strand an unactionable spinner. Settle the part
      // as an error instead. NOT recorded in `pendingToolErrorTexts`: that would
      // append "I couldn't complete the tool action because it failed" and mark
      // the step errored, which is false — no tool failed, and the run stays
      // suspended and resumable by a build that registers the tool.
      this.toolState.delete(callId);
      this.settledToolCallIds.add(callId);
      yield {
        code: DataStreamCode.toolCallResult,
        value: {
          isError: true,
          result: {
            error: `This build has no registered resume UI for ${chunk.toolName}, so its pause cannot be answered here.`,
            resumeSupportedByClient: false,
            runStillSuspended: true,
          },
          toolCallId: callId,
        },
      } satisfies EncodedChunk;
    }
  }

  private *handleToolStart(
    toolName: string,
    callId: string,
    payload: unknown
  ): Generator<EncodedChunk> {
    yield* this.flushPendingRunEvents();
    yield* this.finalizeCurrentTextIfNeeded();
    yield* this.startStepIfNeeded();
    this.toolState.set(callId, {
      argsEmitted: false,
      lastInput: extractToolInput(payload),
      pendingArgsText: '',
      toolName,
    });
    yield {
      code: DataStreamCode.startToolCall,
      value: { toolCallId: callId, toolName },
    } satisfies EncodedChunk;
  }

  private *handleToolProgress(callId: string, payload: unknown): Generator<EncodedChunk> {
    const step = readProgressStep(payload);
    if (step === 'input_stream_delta') {
      const delta = sanitizeDelta((payload as { argsTextDelta?: unknown }).argsTextDelta as string);
      if (!delta) {
        return;
      }
      const state = this.toolState.get(callId);
      // Emit the `c` frame ONLY while this call's args are still streaming.
      // The renderer's assistant-stream decoder closes the call's argsText
      // controller on the complete `9` frame (and throws on unknown ids), so
      // a trailing delta after args completion / after the result — GLM-5.2
      // via OpenRouter emits these — would crash the whole run with an
      // unhandled "Cannot enqueue a chunk into a readable stream that is
      // closed" TypeError. The full args were already assembled from
      // `pendingArgsText`/`lastInput`, so a swallowed trailing delta loses
      // nothing visible.
      if (!state || state.argsEmitted) {
        logger.debug('Dropping tool args delta after args completion', { toolCallId: callId });
        return;
      }
      state.pendingArgsText += delta;
      yield {
        code: DataStreamCode.toolCallArgsTextDelta,
        value: { argsTextDelta: delta, toolCallId: callId },
      } satisfies EncodedChunk;
      return;
    }
    if (step === 'input_stream_end') {
      const state = this.toolState.get(callId);
      if (!state) {
        return;
      }
      const args = toArgsObject(state.lastInput, state.pendingArgsText);
      state.argsEmitted = true;
      yield {
        code: DataStreamCode.toolCall,
        value: { args, toolCallId: callId, toolName: state.toolName },
      } satisfies EncodedChunk;
    }
  }

  private *handleToolSuccess(
    toolName: string,
    callId: string,
    payload: unknown
  ): Generator<EncodedChunk> {
    const output = toJsonSafe(
      (payload as { output?: unknown; result?: unknown }).output ??
        (payload as { result?: unknown }).result
    );
    const state = this.toolState.get(callId);
    // The Mastra `toModelOutput` projection protects model context without
    // mutating raw execution results. This separate, idempotent bound is the
    // final UI transport guard for native, MCP, and replayed stream events.
    const bounded = boundToolOutputForModel(state?.toolName ?? toolName, output);
    if (bounded.errorText) {
      if (state && !state.argsEmitted) {
        const args = toArgsObject(state.lastInput, state.pendingArgsText);
        state.argsEmitted = true;
        yield {
          code: DataStreamCode.toolCall,
          value: { args, toolCallId: callId, toolName: state.toolName },
        } satisfies EncodedChunk;
      }
      this.toolState.delete(callId);
      this.settledToolCallIds.add(callId);
      yield {
        code: DataStreamCode.toolCallResult,
        value: { isError: true, result: bounded.output, toolCallId: callId },
      } satisfies EncodedChunk;
      this.pendingToolErrorTexts.set(callId, bounded.errorText);
      this.startNewStepForNextText = true;
      return;
    }
    if (state && !state.argsEmitted) {
      const args = toArgsObject(state.lastInput, state.pendingArgsText);
      state.argsEmitted = true;
      yield {
        code: DataStreamCode.toolCall,
        value: { args, toolCallId: callId, toolName: state.toolName },
      } satisfies EncodedChunk;
    }
    this.toolState.delete(callId);
    this.settledToolCallIds.add(callId);
    yield {
      code: DataStreamCode.toolCallResult,
      value: { result: bounded.output, toolCallId: callId },
    } satisfies EncodedChunk;
    this.startNewStepForNextText = true;
  }

  private *handleToolError(callId: string, payload: unknown): Generator<EncodedChunk> {
    const output = toJsonSafe(
      (payload as { error?: unknown; result?: unknown }).error ??
        (payload as { result?: unknown }).result ??
        'tool_error'
    );

    // Emit ToolCall with args if we haven't already (needed for UI to display tool)
    const state = this.toolState.get(callId);
    if (state && !state.argsEmitted) {
      const args = toArgsObject(state.lastInput, state.pendingArgsText);
      state.argsEmitted = true;
      yield {
        code: DataStreamCode.toolCall,
        value: { args, toolCallId: callId, toolName: state.toolName },
      } satisfies EncodedChunk;
    }

    this.toolState.delete(callId);
    this.settledToolCallIds.add(callId);
    yield {
      code: DataStreamCode.toolCallResult,
      value: { isError: true, result: output, toolCallId: callId },
    } satisfies EncodedChunk;
    this.pendingToolErrorTexts.set(callId, readToolOutputErrorText(output));
    this.startNewStepForNextText = true;
  }

  private *handleFinish(
    chunk: StreamChunkFinish | StreamChunkMessageFinish
  ): Generator<EncodedChunk> {
    const usage = extractFinishUsage(chunk);
    const finishReason = resolveFinishReason(chunk);
    const abnormalFinishMessage = getAbnormalFinishMessage(finishReason);
    if (abnormalFinishMessage) {
      this.pendingRunErrorText = abnormalFinishMessage;
      this.terminalFailureText = abnormalFinishMessage;
      this.markCurrentStepAsError();
      yield { code: DataStreamCode.error, value: abnormalFinishMessage } satisfies EncodedChunk;
    } else if (finishReason === 'error' && !this.terminalFailureText) {
      // An error finish is terminal by definition, but `getAbnormalFinishMessage`
      // deliberately returns undefined for 'error' — the termination helpers have
      // ALREADY emitted the human-readable detail as a visible text-delta, so
      // returning a message here would double-report it to the user.
      //
      // The durable outcome still has to say `failed`. Without this branch a
      // provider failure emitted `run.failed` + an error finish yet persisted
      // `thread_runs.status = 'completed', error = NULL` — so the run ledger
      // contradicted its own run events, and the debug bundle's Failure summary
      // (which reads `thread_runs`) reported success for precisely the runs it
      // exists to diagnose. `docs/agents/assistant-runtime.md` already requires
      // a terminal failure to produce "run.failed, an error finish, and a failed
      // durable run outcome"; this is the missing third part.
      //
      // Deliberately NOT setting `pendingRunErrorText`: that drives the visible
      // fallback text, which would duplicate the helper's text-delta.
      //
      // KNOWN REMAINING GAP: `finishReason: 'unknown'` still has the same
      // split — `makeTerminalRunEvent` emits `run.failed` for it while this
      // branch leaves the outcome `completed`. It is deliberately NOT handled
      // here: `resolveFinishReason` also returns 'unknown' when a provider
      // simply omits `finishReason` on an otherwise-normal final chunk, so
      // sweeping it in would mark healthy runs failed. The two sides genuinely
      // disagree about what 'unknown' means and that needs reconciling in one
      // place, not a reflex here. Tracked separately.
      this.terminalFailureText = this.runFailedEventText ?? ERROR_FINISH_FALLBACK_TEXT;
    }
    const stepBeforeFinalize = this.currentStep;
    if (this.currentStep) {
      this.currentStep.usage = usage;
      this.currentStep.finishReason = this.currentStep.status === 'error' ? 'error' : finishReason;
    }
    yield* this.flushPendingRunEvents();
    yield* this.emitVisibleFallbackIfNeeded();
    yield* this.emitPendingToolErrorFallbackIfNeeded();
    yield* this.finalizeCurrentStep();
    yield {
      code: DataStreamCode.finishMessage,
      value: {
        ...(chunk.billedCostUsd === undefined ? {} : { billedCostUsd: chunk.billedCostUsd }),
        finishReason: abnormalFinishMessage
          ? 'error'
          : (stepBeforeFinalize?.finishReason ?? finishReason),
        path: [],
        usage,
      },
    } satisfies EncodedChunk;
    this.finishEmitted = true;
  }

  private *startStepIfNeeded(forceNew = false): Generator<EncodedChunk> {
    if (this.currentStep && !forceNew) {
      return;
    }
    if (this.currentStep && forceNew) {
      yield* this.finalizeCurrentStep();
    }
    const stepId = `${this.messageId}:step:${this.nextStepIndex}`;
    this.currentStep = {
      finishReason: 'unknown',
      id: stepId,
      index: this.nextStepIndex,
      status: 'success',
      usage: toDataStreamUsage(),
    } satisfies StepState;
    this.nextStepIndex += 1;
    yield {
      code: DataStreamCode.startStep,
      value: {
        messageId: this.messageId,
        path: [],
      },
    } satisfies EncodedChunk;
  }

  private *finalizeCurrentTextIfNeeded(): Generator<EncodedChunk> {
    if (this.startNewStepForNextText) {
      yield* this.finalizeCurrentStep();
      yield* this.startStepIfNeeded(true);
      this.startNewStepForNextText = false;
    }
  }

  private *finalizeCurrentStep(): Generator<EncodedChunk> {
    if (!this.currentStep) {
      return;
    }
    const step = this.currentStep;
    this.currentStep = null;
    yield {
      code: DataStreamCode.finishStep,
      value: {
        finishReason: step.finishReason,
        isContinued: false,
        path: [],
        usage: step.usage,
      },
    } satisfies EncodedChunk;
  }

  private markCurrentStepAsError(): void {
    if (this.currentStep) {
      this.currentStep.status = 'error';
      this.currentStep.finishReason = 'error';
    }
  }

  private *emitVisibleFallbackIfNeeded(): Generator<EncodedChunk> {
    if (
      !this.pendingRunErrorText &&
      (this.hasVisibleText || this.currentStep?.status !== 'error')
    ) {
      return;
    }
    const errorText =
      this.pendingRunErrorText ?? 'The assistant run failed before producing a response.';
    const visibleText = formatVisibleFailure(RUN_FAILURE_VISIBLE_PREFIX, errorText);
    this.pendingRunErrorText = null;
    yield* this.startStepIfNeeded();
    this.hasVisibleText = true;
    yield { code: DataStreamCode.textDelta, value: visibleText } satisfies EncodedChunk;
  }

  private *emitPendingToolErrorFallbackIfNeeded(): Generator<EncodedChunk> {
    if (this.pendingToolErrorTexts.size === 0) {
      return;
    }
    if (this.startNewStepForNextText) {
      yield* this.finalizeCurrentStep();
      yield* this.startStepIfNeeded(true);
      this.startNewStepForNextText = false;
    } else {
      yield* this.startStepIfNeeded();
    }
    const visibleText = formatToolActionFailure([...this.pendingToolErrorTexts.values()]);
    this.pendingToolErrorTexts.clear();
    this.hasVisibleText = true;
    yield { code: DataStreamCode.textDelta, value: visibleText } satisfies EncodedChunk;
  }
}
