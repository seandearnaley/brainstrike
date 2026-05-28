import { ASSISTANT_RUN_EVENT_DATA_NAME } from '../run-events';
import type {
  StreamChunk,
  StreamChunkFinish,
  StreamChunkMessageFinish,
  StreamChunkReasoning,
  StreamChunkRunEvent,
  StreamChunkText,
  StreamChunkTool,
  StreamFinishReason,
} from '../types';
import { DataStreamCode, type EncodedChunk } from './data-stream-codes';
import { toJsonSafe } from './json';

interface ToolState {
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
  inputTokens: number;
  outputTokens: number;
}

const RUN_FAILURE_VISIBLE_PREFIX = "I couldn't complete the assistant response:";
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
  return { inputTokens, outputTokens };
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
  private pendingToolErrorTexts: string[] = [];
  private startNewStepForNextText = false;

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
      case 'tool-event':
        yield* this.handleToolEvent(chunk);
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
    yield* this.finalizeCurrentStep();
    if (!this.finishEmitted) {
      const usage = this.currentStep?.usage ?? toDataStreamUsage();
      yield {
        code: DataStreamCode.finishMessage,
        value: {
          finishReason: 'error',
          usage,
          path: [],
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
    chunks.push(...this.emitVisibleFallbackIfNeeded());
    chunks.push(...this.emitPendingToolErrorFallbackIfNeeded());
    chunks.push(...this.finalizeCurrentStep());
    const usage = this.currentStep?.usage ?? toDataStreamUsage();
    const reason = this.currentStep?.finishReason ?? 'unknown';
    chunks.push({
      code: DataStreamCode.finishMessage,
      value: {
        finishReason: this.currentStep?.status === 'error' ? 'error' : reason,
        usage,
        path: [],
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
    this.pendingToolErrorTexts = [];
    this.hasVisibleText = true;
    yield { code: DataStreamCode.textDelta, value: delta } satisfies EncodedChunk;
  }

  private *handleReasoningDelta(chunk: StreamChunkReasoning): Generator<EncodedChunk> {
    const delta = sanitizeDelta(chunk.value);
    if (!delta) {
      return;
    }
    yield* this.startStepIfNeeded();
    yield { code: DataStreamCode.reasoningDelta, value: delta } satisfies EncodedChunk;
  }

  private *handleRunEvent(chunk: StreamChunkRunEvent): Generator<EncodedChunk> {
    yield {
      code: DataStreamCode.auiDataPart,
      value: {
        name: ASSISTANT_RUN_EVENT_DATA_NAME,
        data: toJsonSafe(chunk.event),
      },
    } satisfies EncodedChunk;
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
        existingState.lastInput = extractToolInput(chunk.payload);
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
        yield* this.handleToolSuccess(callId, chunk.payload);
        break;
      case 'error':
        yield* this.handleToolError(callId, chunk.payload);
        break;
      default:
        break;
    }
  }

  private *handleToolStart(
    toolName: string,
    callId: string,
    payload: unknown
  ): Generator<EncodedChunk> {
    yield* this.finalizeCurrentTextIfNeeded();
    yield* this.startStepIfNeeded();
    this.toolState.set(callId, {
      toolName,
      pendingArgsText: '',
      lastInput: extractToolInput(payload),
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
        value: { toolCallId: callId, argsTextDelta: delta },
      } satisfies EncodedChunk;
      return;
    }
    if (step === 'input_stream_end') {
      const state = this.toolState.get(callId);
      if (!state) {
        return;
      }
      const args = toArgsObject(state.lastInput, state.pendingArgsText);
      yield {
        code: DataStreamCode.toolCall,
        value: { toolCallId: callId, toolName: state.toolName, args },
      } satisfies EncodedChunk;
    }
  }

  private *handleToolSuccess(callId: string, payload: unknown): Generator<EncodedChunk> {
    const output = toJsonSafe(
      (payload as { output?: unknown; result?: unknown }).output ??
        (payload as { result?: unknown }).result
    );
    this.toolState.delete(callId);
    yield {
      code: DataStreamCode.toolCallResult,
      value: { toolCallId: callId, result: output },
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
    if (state) {
      const args = toArgsObject(state.lastInput, state.pendingArgsText);
      yield {
        code: DataStreamCode.toolCall,
        value: { toolCallId: callId, toolName: state.toolName, args },
      } satisfies EncodedChunk;
    }

    this.toolState.delete(callId);
    // Tool errors are recoverable at the assistant-message level. Consumers
    // should use this tool result's isError flag rather than finishReason to
    // detect failed tool execution.
    yield {
      code: DataStreamCode.toolCallResult,
      value: { toolCallId: callId, result: output, isError: true },
    } satisfies EncodedChunk;
    const message = typeof output === 'string' ? output : 'Tool execution failed';
    this.pendingToolErrorTexts.push(message);
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
    yield* this.emitVisibleFallbackIfNeeded();
    yield* this.emitPendingToolErrorFallbackIfNeeded();
    yield* this.finalizeCurrentStep();
    yield {
      code: DataStreamCode.finishMessage,
      value: {
        finishReason: abnormalFinishMessage
          ? 'error'
          : (stepBeforeFinalize?.finishReason ?? finishReason),
        usage,
        path: [],
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
      id: stepId,
      index: this.nextStepIndex,
      usage: toDataStreamUsage(),
      finishReason: 'unknown',
      status: 'success',
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
        usage: step.usage,
        isContinued: false,
        path: [],
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
    if (this.hasVisibleText || this.currentStep?.status !== 'error') {
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
    if (this.pendingToolErrorTexts.length === 0) {
      return;
    }
    if (this.startNewStepForNextText) {
      yield* this.finalizeCurrentStep();
      yield* this.startStepIfNeeded(true);
      this.startNewStepForNextText = false;
    } else {
      yield* this.startStepIfNeeded();
    }
    const visibleText = formatToolActionFailure(this.pendingToolErrorTexts);
    this.pendingToolErrorTexts = [];
    this.hasVisibleText = true;
    yield { code: DataStreamCode.textDelta, value: visibleText } satisfies EncodedChunk;
  }
}
