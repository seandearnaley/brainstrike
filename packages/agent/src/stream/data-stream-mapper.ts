import {
  CHILD_CONTINUATION_DATA_NAME,
  type ChildContinuationStreamData,
} from '@brainstrike/assistant-contract/child-followup';
import { CONTEXT_BREAKDOWN_DATA_NAME } from '@brainstrike/assistant-contract/context-breakdown';
import {
  CHILD_USER_MESSAGE_DATA_NAME,
  DELEGATED_CONVERSATION_DATA_NAME,
  type DelegatedConversationStreamData,
} from '@brainstrike/assistant-contract/delegated-conversation-stream';
import { CHILD_RUN_USAGE_DATA_NAME } from '@brainstrike/assistant-contract/run-usage';
import { SHELL_OUTPUT_DATA_NAME } from '@brainstrike/assistant-contract/shell-output';
import {
  type AssistantToolApprovalRequest,
  TOOL_APPROVAL_ANSWERED_DATA_NAME,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  type AssistantToolSuspendRequest,
  TOOL_SUSPEND_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-suspend';
import { createLogger } from '@brainstrike/logging';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '../run-events';
import type {
  StreamChunk,
  StreamChunkChildContinuation,
  StreamChunkChildRunUsage,
  StreamChunkContextBreakdown,
  StreamChunkDelegatedConversation,
  StreamChunkFinish,
  StreamChunkMessageFinish,
  StreamChunkReasoning,
  StreamChunkRunEvent,
  StreamChunkShellOutput,
  StreamChunkText,
  StreamChunkTool,
  StreamChunkToolApprovalAnswered,
  StreamChunkToolApprovalRequired,
  StreamChunkToolSuspendRequired,
  StreamFinishReason,
} from '../types';
import { getAbnormalFinishMessage, type OutputLimitContext } from './abnormal-finish';
import { DataStreamCode, type EncodedChunk } from './data-stream-codes';
import { formatDiagnosticChunkType } from './diagnostic-chunk-type';
import { toJsonSafe } from './json';
import { completeToolInputText } from './tool-input-completion';
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
    return 'absent';
  }
  switch (reason) {
    // `absent` is Brainstrike's internal sentinel re-entering the mapper from
    // agent-streaming; providers do not own this namespace.
    case 'absent':
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
    case 'unrecognized':
      return reason;
    default:
      return 'unrecognized';
  }
}

function toProtocolFinishReason(
  reason: StreamFinishReason
): Exclude<StreamFinishReason, 'absent' | 'unrecognized'> {
  if (reason === 'absent') {
    // assistant-stream 0.3.25 has no `absent` wire value. Its `unknown` value
    // is explicitly complete and preserves that no provider reason was known.
    return 'unknown';
  }
  if (reason === 'unrecognized') {
    return 'error';
  }
  return reason;
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
  private readonly outputLimitContext: OutputLimitContext | undefined;
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
  private readonly delegatedMappers = new Map<string, DataStreamMapper>();
  /**
   * True while a text/reasoning part is streaming. Data parts emitted while a
   * part is open CLOSE it downstream (assistant-stream's appendData ends the
   * active append), slicing visible text into fragments. Run events that
   * arrive mid-part are deferred to pendingRunEventChunks and flushed at the
   * next natural boundary (tool start, approval, finish, stream end).
   */
  private streamingPartOpen = false;
  /**
   * The tool call whose args stream is open on the wire (`b` emitted, its `9`
   * not yet), or null. Data parts are deferred while this is non-null, exactly
   * like the mid-text deferral above.
   *
   * ORIGIN (assistant-stream 0.3.25–0.3.34): the renderer decoder closed the
   * ACTIVE call's argsText controller on EVERY frame in its
   * TOOL_CALL_ARGS_CLOSING_CHUNKS set (`b`/`9`/`0`/`g`/`h`/`3`/`e`/`d`/aui-*),
   * so an aui-data part interleaved between `c` frames made the next args delta
   * append to a closed controller: an unhandled "Cannot enqueue a chunk into a
   * readable stream that is closed" TypeError that killed the renderer pipeline
   * while the agent-side run completed invisibly (BST-962; the incident was an
   * OM-observer run event landing mid `updateWorkingMemory` args).
   *
   * NOW (pinned 0.3.37): 0.3.35 REMOVED that set. argsText closes only on an
   * explicit frame (`9`, a `c` with `isFinal`, the `a` result, or the
   * stream-wide close run by `3`/`e`/`d` and flush), and a late `c` is dropped
   * behind a `console.warn` instead of throwing. This deferral is therefore now
   * stricter than the decoder requires — kept because deferral is still the
   * failsafe direction (a late data part flushes at the next boundary; a
   * premature one now silently discards args, which is quieter, not better),
   * and because the emitted ordering stays valid against both decoders. See
   * docs/agents/assistant-runtime.md, BST-962 paragraph.
   *
   * Deliberately NOT force-closed when a second `b` opens (parallel tool
   * calls): the pinned parallel-call contract assembles args from deltas that
   * arrive after another call started, and providers stream args sequentially,
   * so only the tracked id moves to the newest call. (At 0.3.37 that interleave
   * is no longer decoder-lethal either — distinct ids get distinct controllers.)
   */
  private openArgsCallId: string | null = null;
  private pendingRunEventChunks: EncodedChunk[] = [];

  constructor(messageId: string, outputLimitContext?: OutputLimitContext) {
    this.messageId = messageId;
    this.outputLimitContext = outputLimitContext;
  }

  initialChunks(): EncodedChunk[] {
    return [...this.startStepIfNeeded()];
  }

  *handleChunk(chunk: StreamChunk): Generator<EncodedChunk> {
    if (this.finishEmitted) {
      return;
    }

    switch (chunk.type) {
      case 'child-user-message': {
        const encoded = {
          code: DataStreamCode.auiDataPart,
          value: {
            data: {
              ...(chunk.attachments ? { attachments: chunk.attachments } : {}),
              createdAt: chunk.createdAt,
              id: chunk.id,
              text: chunk.text,
            },
            name: CHILD_USER_MESSAGE_DATA_NAME,
          },
        };
        if (this.openArgsCallId !== null) {
          this.pendingRunEventChunks.push(encoded);
          return;
        }
        // Human input deliberately ends the previous assistant text part.
        yield* this.flushPendingRunEvents();
        yield encoded;
        return;
      }
      case 'child-continuation-chunk':
        yield* this.handleChildContinuation(chunk);
        return;
      case 'delegated-conversation-chunk':
        yield* this.handleDelegatedConversation(chunk);
        return;
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
      case 'child-run-usage':
        yield* this.handleChildRunUsage(chunk);
        return;
      case 'tool-call-telemetry':
        // Internal desktop persistence payload. A run without a durable run id
        // has no writer wrapper, so never expose it to the renderer.
        return;
      case 'token-estimate-calibration':
        // Internal desktop persistence payload. A run without a durable run id
        // has no writer wrapper, so never expose it to the renderer.
        return;
      case 'tool-event':
        yield* this.handleToolEvent(chunk);
        return;
      case 'tool-approval-required':
        yield* this.handleToolApprovalRequired(chunk);
        return;
      case 'tool-approval-answered':
        yield* this.handleToolApprovalAnswered(chunk);
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

  private *handleChildContinuation(chunk: StreamChunkChildContinuation): Generator<EncodedChunk> {
    const key = JSON.stringify(['continuation', chunk.continuationId, chunk.nativeRunId]);
    let mapper = this.delegatedMappers.get(key);
    const frames: EncodedChunk[] = [];
    if (!mapper) {
      mapper = new DataStreamMapper(chunk.messageId);
      this.delegatedMappers.set(key, mapper);
      frames.push(...mapper.initialChunks());
    }
    frames.push(...mapper.handleChunk(chunk.chunk));
    if (chunk.chunk.type === 'message-finish' || chunk.chunk.type === 'finish') {
      this.delegatedMappers.delete(key);
    }
    if (frames.length === 0) {
      return;
    }
    const data: ChildContinuationStreamData = {
      continuationId: chunk.continuationId,
      frames,
      messageId: chunk.messageId,
      nativeRunId: chunk.nativeRunId,
      threadId: chunk.threadId,
      ...(chunk.baseline ? { baseline: chunk.baseline } : {}),
    };
    yield {
      code: DataStreamCode.data,
      value: [{ data: toJsonSafe(data), name: CHILD_CONTINUATION_DATA_NAME }],
    };
  }

  private *handleDelegatedConversation(
    chunk: StreamChunkDelegatedConversation
  ): Generator<EncodedChunk> {
    if (!chunk.messageId?.trim()) {
      throw new Error('Delegated transport requires an observed native message identity.');
    }
    const key = JSON.stringify([
      chunk.identity.parentRuntimeRunId,
      chunk.identity.parentToolCallId,
      chunk.identity.childRuntimeRunId,
    ]);
    let mapper = this.delegatedMappers.get(key);
    const frames: EncodedChunk[] = [];
    if (!mapper) {
      // One invocation owns the same decoder across native message/step changes.
      // Each envelope retains the observed native message id for durable routing.
      // A pinned child must not inherit a model-specific parent error explanation.
      mapper = new DataStreamMapper(chunk.messageId);
      this.delegatedMappers.set(key, mapper);
      frames.push(...mapper.initialChunks());
    }
    frames.push(...mapper.handleChunk(chunk.chunk));
    if (chunk.chunk.type === 'message-finish' || chunk.chunk.type === 'finish') {
      this.delegatedMappers.delete(key);
    }
    if (frames.length === 0) {
      return;
    }
    const data: DelegatedConversationStreamData = {
      ...(chunk.continuationId ? { continuationId: chunk.continuationId } : {}),
      frames,
      ...(chunk.baseline ? { baseline: chunk.baseline } : {}),
      identity: chunk.identity,
      messageId: chunk.messageId,
      ...(chunk.partId ? { partId: chunk.partId } : {}),
    };
    // The vendor's out-of-band data frame leaves parent text/args controllers
    // open. A child must remain live while the parent awaits its result.
    yield {
      code: DataStreamCode.data,
      value: [{ data: toJsonSafe(data), name: DELEGATED_CONVERSATION_DATA_NAME }],
    };
  }

  *handleError(error: unknown): Generator<EncodedChunk> {
    const errorText = error instanceof Error ? error.message : String(error);
    this.terminalFailureText = errorText;
    this.markCurrentStepAsError();
    // `3` closes an open args stream in the decoder; end it with its `9` first.
    yield* this.closeOpenArgsStreamIfNeeded();
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
    // `3`/`e`/`d` close an open args stream in the decoder; end it first.
    chunks.push(...this.closeOpenArgsStreamIfNeeded());
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
    // End an open args stream with its `9` before the model's visible text
    // starts. A `0` frame closed the active argsText downstream through
    // assistant-stream 0.3.34; at the pinned 0.3.37 it no longer does, but the
    // `9` still has to precede the text so the args are complete before the
    // next `3`/`e`/`d` closes the controller without them.
    yield* this.closeOpenArgsStreamIfNeeded();
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
    // Same ordering rule as `0` above (see handleTextDelta).
    yield* this.closeOpenArgsStreamIfNeeded();
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
    if (this.mustDeferDataParts()) {
      this.pendingRunEventChunks.push(encoded);
      return;
    }
    yield encoded;
  }

  /**
   * Emit a live shell-output slice as a transient `aui-data` part. Subject to
   * the SAME deferral contract as run events: a data part emitted mid
   * text/reasoning append would slice visible text, and one emitted inside an
   * open args stream crashes the renderer decoder (BST-962), so while either
   * is open the encoded slice is queued and flushed at the next boundary.
   * Shell output is produced during tool execution, and the executing call's
   * args window is guaranteed closed by then — streaming providers close it at
   * input_stream_end, non-streaming ones at the eager `9` in handleToolStart —
   * so in practice it streams live; the deferral only guards a concurrent
   * OTHER call still streaming its args.
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
    if (this.mustDeferDataParts()) {
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
    if (this.mustDeferDataParts()) {
      this.pendingRunEventChunks.push(encoded);
      return;
    }
    yield encoded;
  }

  /**
   * Emit a child model-call's usage (subagent / OM cycle, BST-953) as a
   * transient `aui-data` part — the renderer refreshes its thread-total
   * readout from it; the durable row was already written server-side. Same
   * text-part deferral contract as the context breakdown above.
   */
  private *handleChildRunUsage(chunk: StreamChunkChildRunUsage): Generator<EncodedChunk> {
    const encoded = {
      code: DataStreamCode.auiDataPart,
      value: {
        data: toJsonSafe(chunk.value),
        name: CHILD_RUN_USAGE_DATA_NAME,
      },
    } satisfies EncodedChunk;
    if (this.mustDeferDataParts()) {
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

  /** True whenever a data part emitted now would close an open wire part. */
  private mustDeferDataParts(): boolean {
    return this.streamingPartOpen || this.openArgsCallId !== null;
  }

  /**
   * Close the open args stream by emitting its args-complete `9` frame with
   * whatever args have accumulated. Used before any args-closing frame the
   * mapper is about to emit (text/reasoning deltas, error, finish) so the
   * decoder never sees one inside an open args window.
   */
  private *closeOpenArgsStreamIfNeeded(): Generator<EncodedChunk> {
    const callId = this.openArgsCallId;
    if (callId === null) {
      return;
    }
    this.openArgsCallId = null;
    const state = this.toolState.get(callId);
    if (!state || state.argsEmitted) {
      return;
    }
    yield* this.finishToolArgs(callId, state);
  }

  /**
   * Bookkeeping after a call's args-complete `9` frame reached the wire: the
   * args window is closed, so deferred data parts may flow again.
   */
  private *completeArgsStream(callId: string): Generator<EncodedChunk> {
    if (this.openArgsCallId === callId) {
      this.openArgsCallId = null;
    }
    if (this.openArgsCallId === null) {
      yield* this.flushPendingRunEvents();
    }
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

    const existingState = this.toolState.get(callId);
    if (existingState && chunk.status !== 'progress') {
      // Native terminal events may carry complete input after the final delta was lost.
      const nextInput = extractToolInput(chunk.payload);
      if (
        nextInput !== undefined &&
        !(hasNonEmptyToolInput(existingState.lastInput) && !hasNonEmptyToolInput(nextInput))
      ) {
        existingState.lastInput = nextInput;
      }
    }
    if (chunk.status === 'start') {
      if (existingState) {
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
      case 'declined':
        yield* this.handleToolDeclined(callId, chunk.payload);
        break;
      default:
        break;
    }
  }

  /**
   * A parked sibling approval the host answered under a session grant: a
   * plain aui-data part keyed like the notice it answers, so that card locks
   * live and after reload (the part persists with the assistant message).
   */
  private *handleToolApprovalAnswered(
    chunk: StreamChunkToolApprovalAnswered
  ): Generator<EncodedChunk> {
    const { type: _type, ...data } = chunk;
    const encoded = {
      code: DataStreamCode.auiDataPart,
      value: { data, name: TOOL_APPROVAL_ANSWERED_DATA_NAME },
    } satisfies EncodedChunk;
    // A live grant is an interaction boundary, like an approval request. The
    // parent may be parked after text while children resume, so waiting for its
    // next text/tool/finish boundary leaves consumed sibling controls actionable.
    // Do not truncate a concurrent parent tool's still-streaming arguments.
    if (this.openArgsCallId !== null) {
      this.pendingRunEventChunks.push(encoded);
      return;
    }
    yield* this.flushPendingRunEvents();
    yield encoded;
  }

  private *handleToolApprovalRequired(
    chunk: StreamChunkToolApprovalRequired
  ): Generator<EncodedChunk> {
    const callId = sanitizeToolCallId(chunk.toolCallId);
    if (!callId) {
      return;
    }
    // If a DIFFERENT call's args stream is open, end it first: the frames
    // below (`9` for this call, then aui-data) would close it mid-stream in
    // the decoder (BST-962 crash class), and the pause notice cannot wait —
    // a paused run produces no further boundary to flush at.
    if (this.openArgsCallId !== null && this.openArgsCallId !== callId) {
      yield* this.closeOpenArgsStreamIfNeeded();
    }

    // Settled-id rule, frames only: never AUTO-START a settled call (a
    // duplicate `b` throws in the renderer decoder — the crash class the
    // handleToolEvent guard closes). The approval NOTICE below is a plain
    // aui-data part that touches no tool controller, so it still flows — a
    // genuinely suspended run must keep its pause UI even when the call's
    // frames already settled (legacy error-then-suspend ordering, #1606).
    if (!(this.toolState.has(callId) || this.settledToolCallIds.has(callId))) {
      yield* this.handleToolStart(chunk.toolName, callId, {
        args: chunk.args,
        input: chunk.args,
      });
    }

    const state = this.toolState.get(callId);
    const args = chunk.args ?? state?.lastInput;
    if (state && !state.argsEmitted) {
      yield* this.finishToolArgs(callId, state, args);
    }
    // Deferred run events flush only now, AFTER the args-complete `9` — the
    // pre-BST-962 top-of-handler flush landed them inside the open args
    // stream. They still precede the approval notice below.
    yield* this.completeArgsStream(callId);

    const data: AssistantToolApprovalRequest = {
      ...(chunk.delegation ? { delegation: chunk.delegation } : {}),
      // The host leg the pause was streamed by (see the field-by-field warning
      // below): the ONLY anchor the history topology adapter can resolve a
      // suspended message's parent with — `runId` beside it is the native
      // Mastra run, which never matches a thread-run row. Forwarded only when
      // non-blank, so the wire stays as strict as the action guard it feeds: a
      // blank id would reach the echo and fail `isBoundedIdentifier` there,
      // rejecting the whole decision at the resume boundary.
      ...(chunk.hostRunId?.trim() ? { hostRunId: chunk.hostRunId } : {}),
      ...(chunk.timelineRunId?.trim() ? { timelineRunId: chunk.timelineRunId } : {}),
      runId: chunk.runId,
      toolCallId: callId,
      toolName: chunk.toolName,
      ...(chunk.riskCategory === undefined ? {} : { riskCategory: chunk.riskCategory }),
      ...(chunk.policyDecision === undefined ? {} : { policyDecision: chunk.policyDecision }),
      ...(args === undefined ? {} : { args: toJsonSafe(args) }),
      ...(chunk.resumeSchema === undefined ? {} : { resumeSchema: toJsonSafe(chunk.resumeSchema) }),
      // BST-1070: this rebuild is field-by-field, so anything not explicitly
      // spread is DROPPED — omitting this line would starve every LIVE
      // approval of its execution context while rediscovered ones (which
      // recompute server-side) kept working, precisely backwards. Pinned by
      // the live-transport test in data-stream-session.spec.ts.
      ...(chunk.executionContext === undefined ? {} : { executionContext: chunk.executionContext }),
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
    // Mirrors handleToolApprovalRequired: a different call's open args stream
    // must end before this call's frames can flow (BST-962 crash class).
    if (this.openArgsCallId !== null && this.openArgsCallId !== callId) {
      yield* this.closeOpenArgsStreamIfNeeded();
    }

    // Settled-id rule, frames only (mirrors handleToolApprovalRequired): the
    // suspend NOTICE below still flows for a settled call — in the legacy
    // error-then-suspend ordering (#1606 above) the run IS genuinely
    // suspended and must keep its pause UI — but a settled call is never
    // auto-started (duplicate `b` throws in the renderer decoder).
    if (!(this.toolState.has(callId) || this.settledToolCallIds.has(callId))) {
      yield* this.handleToolStart(chunk.toolName, callId, {});
    }

    // Emit the tool-call args part (if not yet emitted) so assistant-ui shows the
    // tool invocation the plan/question belongs to. The suspend payload is the
    // pause data, not the tool input, so args default to the recorded input.
    const state = this.toolState.get(callId);
    if (state && !state.argsEmitted) {
      yield* this.finishToolArgs(callId, state);
    }
    // Text-part deferral contract: deferred run events flush AFTER this call's
    // args-complete `9` (a flush inside the open args stream is the BST-962
    // crash) and BEFORE the suspend notice below.
    yield* this.completeArgsStream(callId);

    const data: AssistantToolSuspendRequest = {
      ...(chunk.delegation ? { delegation: chunk.delegation } : {}),
      // Same host-leg anchor as the approval part above (non-blank only); this
      // rebuild is field-by-field, so an unspread field is silently dropped.
      ...(chunk.hostRunId?.trim() ? { hostRunId: chunk.hostRunId } : {}),
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

    if (chunk.resumeSupported === false && !this.settledToolCallIds.has(callId)) {
      // BST-558: this build has no registered resume UI for the tool, so nothing
      // will ever produce this call's result. Leaving it open would keep a
      // Running ToolFallback forever — and the notice above is dismissible, so a
      // dismissed notice would strand an unactionable spinner. Settle the part
      // as an error instead (skipped for an ALREADY-settled call — a second
      // result frame against a responded controller is the settled-id crash
      // class). NOT recorded in `pendingToolErrorTexts`: that would
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
    // Skip the boundary flush while another call's args stream is open: a
    // flushed data part would land inside that stream (the BST-962 crash);
    // deferred chunks flow at the next args-complete frame instead.
    if (this.openArgsCallId === null) {
      yield* this.flushPendingRunEvents();
    }
    yield* this.finalizeCurrentTextIfNeeded();
    yield* this.startStepIfNeeded();
    const state: ToolState = {
      argsEmitted: false,
      lastInput: extractToolInput(payload),
      pendingArgsText: '',
      toolName,
    };
    this.toolState.set(callId, state);
    yield {
      code: DataStreamCode.startToolCall,
      value: { toolCallId: callId, toolName },
    } satisfies EncodedChunk;
    // The `b` frame re-points the decoder's active argsText at this call.
    this.openArgsCallId = callId;
    // A start that already carries the complete input is the non-streaming
    // provider path (a `tool-call` part; no input_stream_* events will
    // follow), so the args window would otherwise stay open across the whole
    // EXECUTION — deferring live shell output and run events until the
    // result. Send its complete input and close it now. Streaming
    // providers map `tool-call-input-streaming-start` to a start WITHOUT
    // input, so they are unaffected; a defensive late delta is dropped by the
    // argsEmitted guard either way.
    if (hasNonEmptyToolInput(state.lastInput)) {
      yield* this.finishToolArgs(callId, state);
      yield* this.completeArgsStream(callId);
    }
  }

  /** After `b`, the native decoder reads arguments from `c`; `9` only closes them. */
  private *finishToolArgs(
    callId: string,
    state: ToolState,
    input: unknown = state.lastInput
  ): Generator<EncodedChunk> {
    const args = toArgsObject(input, state.pendingArgsText);
    let missingText = '';
    let completionError: Error | undefined;
    try {
      if (state.pendingArgsText.length === 0 || (input !== undefined && input !== null)) {
        missingText = completeToolInputText(state.pendingArgsText, args);
      }
    } catch (error) {
      completionError = error instanceof Error ? error : new Error(String(error));
    }
    state.argsEmitted = true;
    if (missingText.length > 0) {
      state.pendingArgsText += missingText;
      yield {
        code: DataStreamCode.toolCallArgsTextDelta,
        value: { argsTextDelta: missingText, toolCallId: callId },
      } satisfies EncodedChunk;
    }
    yield {
      code: DataStreamCode.toolCall,
      value: { args, toolCallId: callId, toolName: state.toolName },
    } satisfies EncodedChunk;
    // Close the append-only input exactly once before failing the session.
    // Otherwise handleError would attempt the same invalid completion again.
    if (completionError) {
      throw completionError;
    }
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
      // controller on the complete `9` frame (and throws in strict mode on
      // unknown ids), so a trailing delta after args completion / after the
      // result — GLM-5.2 via OpenRouter emits these — lands on a closed
      // controller. Through 0.3.34 that crashed the whole run with an unhandled
      // "Cannot enqueue a chunk into a readable stream that is closed"
      // TypeError; at the pinned 0.3.37 it is dropped behind a one-shot
      // console.warn instead. The guard stays either way — the full args were
      // already assembled from `pendingArgsText`/`lastInput`, so a swallowed
      // trailing delta loses nothing visible, and a quiet drop is harder to
      // notice than the old crash was.
      if (!state || state.argsEmitted) {
        logger.debug('Dropping tool args delta after args completion', { toolCallId: callId });
        return;
      }
      // Deltas supersede an earlier empty placeholder. A later terminal's
      // explicit empty input is still authoritative and can complete `{`/`[`.
      if (!hasNonEmptyToolInput(state.lastInput)) {
        state.lastInput = undefined;
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
      // Mirror the delta branch's argsEmitted guard: after a forced close
      // (text/reasoning arrived mid-args, or another call settled) the `9` is
      // already on the wire. Re-emitting it is another args-closing frame
      // (crash class), and its completeArgsStream flush would land deferred
      // aui-data inside the text block that forced the close.
      if (!state || state.argsEmitted) {
        return;
      }
      yield* this.finishToolArgs(callId, state);
      yield* this.completeArgsStream(callId);
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
    // A different call's open args stream must end before this call's `9`
    // frame can flow (BST-962 crash class).
    if (this.openArgsCallId !== null && this.openArgsCallId !== callId) {
      yield* this.closeOpenArgsStreamIfNeeded();
    }
    const state = this.toolState.get(callId);
    // The Mastra `toModelOutput` projection protects model context without
    // mutating raw execution results. This separate, idempotent bound is the
    // final UI transport guard for native, MCP, and replayed stream events.
    const bounded = boundToolOutputForModel(state?.toolName ?? toolName, output);
    if (bounded.errorText) {
      if (state && !state.argsEmitted) {
        yield* this.finishToolArgs(callId, state);
      }
      this.toolState.delete(callId);
      this.settledToolCallIds.add(callId);
      yield {
        code: DataStreamCode.toolCallResult,
        value: { isError: true, result: bounded.output, toolCallId: callId },
      } satisfies EncodedChunk;
      yield* this.completeArgsStream(callId);
      this.pendingToolErrorTexts.set(callId, bounded.errorText);
      this.startNewStepForNextText = true;
      return;
    }
    if (state && !state.argsEmitted) {
      yield* this.finishToolArgs(callId, state);
    }
    this.toolState.delete(callId);
    this.settledToolCallIds.add(callId);
    yield {
      code: DataStreamCode.toolCallResult,
      value: { result: bounded.output, toolCallId: callId },
    } satisfies EncodedChunk;
    yield* this.completeArgsStream(callId);
    this.startNewStepForNextText = true;
  }

  private *handleToolError(callId: string, payload: unknown): Generator<EncodedChunk> {
    const output = toJsonSafe(
      (payload as { error?: unknown; result?: unknown }).error ??
        (payload as { result?: unknown }).result ??
        'tool_error'
    );

    // A different call's open args stream must end before this call's `9`
    // frame can flow (BST-962 crash class).
    if (this.openArgsCallId !== null && this.openArgsCallId !== callId) {
      yield* this.closeOpenArgsStreamIfNeeded();
    }

    // Emit ToolCall with args if we haven't already (needed for UI to display tool)
    const state = this.toolState.get(callId);
    if (state && !state.argsEmitted) {
      yield* this.finishToolArgs(callId, state);
    }

    this.toolState.delete(callId);
    this.settledToolCallIds.add(callId);
    yield {
      code: DataStreamCode.toolCallResult,
      value: { isError: true, result: output, toolCallId: callId },
    } satisfies EncodedChunk;
    yield* this.completeArgsStream(callId);
    this.pendingToolErrorTexts.set(callId, readToolOutputErrorText(output));
    this.startNewStepForNextText = true;
  }

  /**
   * The approval lifecycle's DECLINE terminal (@mastra/core 1.59
   * `tool-output-denied`, BST-1282). It SETTLES the call exactly like an error
   * would — without a result frame the renderer's part spins forever, the hang
   * the chunk exists to fix — but it is deliberately NOT `handleToolError`:
   *
   *  - It records NOTHING in `pendingToolErrorTexts`. That map only clears on a
   *    later `text-delta`, so a denial that is the last chunk before `finish`
   *    (or a Stop right after it) would otherwise append "I couldn't complete
   *    the tool action because it failed: The user declined this tool call…"
   *    and finalize the step as errored. Nothing failed; the user chose. Same
   *    ruling as the BST-558 resume-unsupported terminal — see
   *    docs/agents/assistant-runtime.md, "The tool card is SETTLED".
   *  - It leaves `isError` OFF. `isError` is what paints the destructive
   *    AlertCircle/Failed chrome; a decline is neither a failure nor a success,
   *    and the `DeclinedToolCallResult` envelope in the result is what tells the
   *    card to render the muted stopped treatment instead.
   */
  private *handleToolDeclined(callId: string, payload: unknown): Generator<EncodedChunk> {
    // A different call's open args stream must end before this call's `9`
    // frame can flow (BST-962 crash class).
    if (this.openArgsCallId !== null && this.openArgsCallId !== callId) {
      yield* this.closeOpenArgsStreamIfNeeded();
    }
    const state = this.toolState.get(callId);
    if (state && !state.argsEmitted) {
      yield* this.finishToolArgs(callId, state);
    }
    this.toolState.delete(callId);
    this.settledToolCallIds.add(callId);
    yield {
      code: DataStreamCode.toolCallResult,
      value: {
        result: toJsonSafe((payload as { result?: unknown } | undefined)?.result),
        toolCallId: callId,
      },
    } satisfies EncodedChunk;
    yield* this.completeArgsStream(callId);
    this.startNewStepForNextText = true;
  }

  private *handleFinish(
    chunk: StreamChunkFinish | StreamChunkMessageFinish
  ): Generator<EncodedChunk> {
    // The frames below (`3`/`e`/`d`, flushed aui-data) all close an open args
    // stream in the decoder; end it with its `9` first (BST-962).
    yield* this.closeOpenArgsStreamIfNeeded();
    const usage = extractFinishUsage(chunk);
    const finishReason = resolveFinishReason(chunk);
    const abnormalFinishMessage = getAbnormalFinishMessage(finishReason, this.outputLimitContext);
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
        finishReason: toProtocolFinishReason(
          abnormalFinishMessage ? 'error' : (stepBeforeFinalize?.finishReason ?? finishReason)
        ),
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
      finishReason: 'absent',
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
        finishReason: toProtocolFinishReason(step.finishReason),
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
