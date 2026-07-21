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
  inputTokens: number;
  outputTokens: number;
}

const RUN_FAILURE_VISIBLE_PREFIX = "I couldn't complete the assistant response:";
const MISSING_FINISH_ERROR_TEXT = 'Assistant stream ended without a normal stop signal.';
const TOOL_ACTION_FAILURE_VISIBLE_PREFIX = "I couldn't complete the tool action because it failed:";
const TOOL_ACTIONS_FAILURE_VISIBLE_PREFIX =
  "I couldn't complete some tool actions because they failed:";

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
  return {
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
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
  private currentStep: StepState | null = null;
  private nextStepIndex = 0;
  private finishEmitted = false;
  private hasVisibleText = false;
  private pendingRunErrorText: string | null = null;
  private readonly pendingToolErrorTexts = new Map<string, string>();
  private startNewStepForNextText = false;
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
      default:
        return;
    }
  }

  *handleError(error: unknown): Generator<EncodedChunk> {
    const errorText = error instanceof Error ? error.message : String(error);
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
    // Mastra reports suspend() through the tool-error path before emitting the
    // correlated suspension event. The pause is intentional, so discard only
    // that call's transient error while preserving unrelated tool failures.
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
      if (state) {
        state.pendingArgsText += delta;
      }
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
      this.markCurrentStepAsError();
      yield { code: DataStreamCode.error, value: abnormalFinishMessage } satisfies EncodedChunk;
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
