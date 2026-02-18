import { createLogger } from '@brainstrike/utils';
import type {
  StreamChunk,
  StreamChunkFinish,
  StreamChunkMessageFinish,
  StreamChunkText,
  StreamChunkTool,
} from '../index';
import { toJsonSafe } from './json';

interface ToolState {
  toolName: string;
  pendingArgsText: string;
  lastInput?: unknown;
}

interface StepState {
  id: string;
  index: number;
  usage: Usage;
  finishReason: FinishReason;
  status: 'success' | 'error';
}

interface Usage {
  promptTokens: number;
  completionTokens: number;
}

type FinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other'
  | 'unknown';

// biome-ignore lint/style/noEnum: Internal enum used for protocol encoding - values must be stable
enum DataStreamCode {
  TextDelta = '0',
  Data = '2',
  Error = '3',
  ToolCall = '9',
  ToolCallResult = 'a',
  StartToolCall = 'b',
  ToolCallArgsTextDelta = 'c',
  FinishMessage = 'd',
  FinishStep = 'e',
  StartStep = 'f',
}

interface EncodedChunk {
  code: DataStreamCode;
  value: unknown;
}

interface StoredChunk {
  sequence: number;
  payload: Uint8Array;
  chunk: EncodedChunk;
}

interface AssistantDataStreamSessionOptions {
  messageId?: string;
  sessionId?: string;
  cleanupDelayMs?: number;
}

interface CreateResponseOptions {
  resumeFromEventId?: string | null;
  headers?: HeadersInit;
}

const logger = createLogger('AgentDataStream');
const encoder = new TextEncoder();
const DEFAULT_CLEANUP_DELAY_MS = 2 * 60 * 1000;
const STREAM_DEBUG_ENABLED = Boolean(process.env['BRAINSTRIKE_DEBUG_STREAM']);

function debugLog(stage: string, payload: unknown): void {
  if (STREAM_DEBUG_ENABLED) {
    logger.debug(`[brainstrike:data-stream] ${stage}`, payload);
  }
}

function encodeChunk({ code, value }: EncodedChunk): Uint8Array {
  return encoder.encode(`${code}:${JSON.stringify(value)}\n`);
}

function parseEventId(
  value: string | null | undefined
): { sessionId: string; sequence: number } | undefined {
  if (!value) {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  const [sessionId, sequenceRaw] = trimmed.split(':');
  if (!(sessionId && sequenceRaw)) {
    return;
  }
  const sequence = Number.parseInt(sequenceRaw, 10);
  if (!Number.isFinite(sequence) || sequence < -1) {
    return;
  }
  return { sessionId, sequence };
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

function toUsage(raw?: { promptTokens?: unknown; completionTokens?: unknown }): Usage {
  const prompt =
    typeof raw?.promptTokens === 'number' && Number.isFinite(raw.promptTokens)
      ? raw.promptTokens
      : 0;
  const completion =
    typeof raw?.completionTokens === 'number' && Number.isFinite(raw.completionTokens)
      ? raw.completionTokens
      : 0;
  return { promptTokens: prompt, completionTokens: completion };
}

function extractFinishUsage(chunk: StreamChunkFinish | StreamChunkMessageFinish): Usage {
  const usage = (chunk as { usage?: { promptTokens?: unknown; completionTokens?: unknown } }).usage;
  return toUsage(usage ?? {});
}

function resolveFinishReason(chunk: StreamChunkFinish | StreamChunkMessageFinish): FinishReason {
  const reason = (chunk as { finishReason?: unknown }).finishReason;
  if (typeof reason !== 'string') {
    return 'unknown';
  }
  switch (reason) {
    case 'stop':
    case 'length':
    case 'content-filter':
    case 'tool-calls':
    case 'error':
    case 'other':
    case 'unknown':
      return reason;
    default:
      return 'unknown';
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

class DataStreamMapper {
  private readonly sessionId: string;
  private readonly messageId: string;
  private readonly toolState = new Map<string, ToolState>();
  private currentStep: StepState | null = null;
  private nextStepIndex = 0;
  private finishEmitted = false;
  private startNewStepForNextText = false;

  constructor(sessionId: string, messageId: string) {
    this.sessionId = sessionId;
    this.messageId = messageId;
  }

  initialChunks(): EncodedChunk[] {
    const createdAt = new Date().toISOString();
    return [
      {
        code: DataStreamCode.Data,
        value: [
          {
            type: 'start',
            messageId: this.messageId,
            sessionId: this.sessionId,
            createdAt,
          },
        ],
      },
      ...this.startStepIfNeeded(),
    ];
  }

  *handleChunk(chunk: StreamChunk): Generator<EncodedChunk> {
    if (this.finishEmitted) {
      return;
    }

    switch (chunk.type) {
      case 'text-delta':
        yield* this.handleTextDelta(chunk);
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
    yield { code: DataStreamCode.Error, value: errorText } satisfies EncodedChunk;
    yield* this.finalizeCurrentStep();
    if (!this.finishEmitted) {
      const usage = this.currentStep?.usage ?? toUsage();
      yield {
        code: DataStreamCode.FinishMessage,
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
    chunks.push(...this.finalizeCurrentStep());
    const usage = this.currentStep?.usage ?? toUsage();
    const reason = this.currentStep?.finishReason ?? 'unknown';
    chunks.push({
      code: DataStreamCode.FinishMessage,
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
    yield { code: DataStreamCode.TextDelta, value: delta } satisfies EncodedChunk;
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
      code: DataStreamCode.StartToolCall,
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
        code: DataStreamCode.ToolCallArgsTextDelta,
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
        code: DataStreamCode.ToolCall,
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
      code: DataStreamCode.ToolCallResult,
      value: { toolCallId: callId, result: output },
    } satisfies EncodedChunk;
    this.startNewStepForNextText = true;
  }

  private *handleToolError(callId: string, payload: unknown): Generator<EncodedChunk> {
    this.markCurrentStepAsError();
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
        code: DataStreamCode.ToolCall,
        value: { toolCallId: callId, toolName: state.toolName, args },
      } satisfies EncodedChunk;
    }

    this.toolState.delete(callId);
    yield {
      code: DataStreamCode.ToolCallResult,
      value: { toolCallId: callId, result: output, isError: true },
    } satisfies EncodedChunk;
    const message = typeof output === 'string' ? output : 'Tool execution failed';
    yield { code: DataStreamCode.Error, value: message } satisfies EncodedChunk;
    this.startNewStepForNextText = true;
  }

  private *handleFinish(
    chunk: StreamChunkFinish | StreamChunkMessageFinish
  ): Generator<EncodedChunk> {
    const usage = extractFinishUsage(chunk);
    const finishReason = resolveFinishReason(chunk);
    const stepBeforeFinalize = this.currentStep;
    if (this.currentStep) {
      this.currentStep.usage = usage;
      this.currentStep.finishReason = this.currentStep.status === 'error' ? 'error' : finishReason;
    }
    yield* this.finalizeCurrentStep();
    yield {
      code: DataStreamCode.FinishMessage,
      value: {
        finishReason: stepBeforeFinalize?.finishReason ?? finishReason,
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
      usage: toUsage(),
      finishReason: 'unknown',
      status: 'success',
    } satisfies StepState;
    this.nextStepIndex += 1;
    yield {
      code: DataStreamCode.StartStep,
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
      code: DataStreamCode.FinishStep,
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
}

export class AssistantDataStreamSession {
  readonly id: string;
  readonly messageId: string;
  private readonly events: StoredChunk[] = [];
  private readonly listeners = new Set<SessionSubscription>();
  private readonly mapper: DataStreamMapper;
  private readonly cleanupDelayMs: number;
  private sequence = 0;
  private closed = false;
  // Abort flag set when Response.body stream is canceled (e.g., user clicks stop)
  // Checked in consumeSource loop to stop consuming from Mastra iterator
  private aborted = false;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly source: AsyncIterable<StreamChunk>,
    private readonly onCleanup: (sessionId: string) => void,
    options?: AssistantDataStreamSessionOptions
  ) {
    const resolved = options ?? {};
    this.id = resolved.sessionId ?? createRandomId('sess');
    this.messageId = resolved.messageId ?? createRandomId('msg');
    this.cleanupDelayMs = resolved.cleanupDelayMs ?? DEFAULT_CLEANUP_DELAY_MS;
    this.mapper = new DataStreamMapper(this.id, this.messageId);
    for (const chunk of this.mapper.initialChunks()) {
      this.recordChunk(chunk);
    }
    void this.startProcessing();
  }

  createResponse(options: CreateResponseOptions = {}): Response {
    const { resumeFromEventId, headers } = options;
    const startIndex = this.resolveStartIndex(resumeFromEventId);
    if (STREAM_DEBUG_ENABLED && resumeFromEventId) {
      debugLog('resume', { session: this.id, resumeFromEventId, startIndex });
    }

    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', 'text/plain; charset=utf-8');
    responseHeaders.set('Cache-Control', 'no-store');
    responseHeaders.set('Connection', 'close');
    responseHeaders.set('x-vercel-ai-data-stream', 'v1');
    responseHeaders.set('x-vercel-ai-ui-message-stream', 'v1');
    if (headers) {
      const init = new Headers(headers);
      for (const [key, value] of init.entries()) {
        if (!responseHeaders.has(key)) {
          responseHeaders.set(key, value);
        }
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const subscription = new SessionSubscription(this, controller, startIndex);
        this.listeners.add(subscription);
        subscription.flushExisting();
        if (this.closed) {
          queueMicrotask(() => subscription.close());
        }
      },
      cancel: () => {
        // Called when client cancels response stream (e.g., user stops generation)
        // Sets abort flag to stop source consumption in consumeSource() loop
        // This prevents backend from continuing to process after client disconnects
        this.aborted = true;
        this.cancelAllListeners();
      },
    });

    return new Response(stream, { status: 200, headers: responseHeaders });
  }

  removeSubscription(subscription: SessionSubscription): void {
    this.listeners.delete(subscription);
    if (this.closed && this.listeners.size === 0) {
      this.scheduleCleanup();
    }
  }

  private cancelAllListeners(): void {
    for (const listener of Array.from(this.listeners)) {
      listener.close();
    }
    this.listeners.clear();
  }

  private resolveStartIndex(resumeFromEventId: string | null | undefined): number {
    if (!resumeFromEventId) {
      return 0;
    }
    const parsed = parseEventId(resumeFromEventId);
    if (!parsed || parsed.sessionId !== this.id) {
      return 0;
    }
    const index = parsed.sequence + 1;
    if (index <= 0) {
      return 0;
    }
    return Math.min(index, this.events.length);
  }

  private scheduleCleanup(): void {
    if (this.cleanupTimer) {
      return;
    }
    const timer = setTimeout(() => {
      this.cleanupTimer = null;
      this.onCleanup(this.id);
    }, this.cleanupDelayMs);
    (timer as { unref?: () => void }).unref?.();
    this.cleanupTimer = timer;
  }

  private emitParts(parts: Iterable<EncodedChunk>): void {
    for (const part of parts) {
      this.recordChunk(part);
    }
  }

  private async consumeSource(): Promise<void> {
    // Consume chunks from source (Mastra agent stream) and emit them to listeners
    // Checks abort flag on each iteration to stop when client cancels
    for await (const chunk of this.source) {
      // Abort check: stop consuming if response stream was canceled
      if (this.aborted) {
        break;
      }
      this.emitParts(this.mapper.handleChunk(chunk));
      if (this.mapper.didEmitFinish()) {
        break;
      }
    }
  }

  private finalizeStream(): void {
    if (!this.mapper.didEmitFinish()) {
      this.emitParts(this.mapper.finalizeOnStreamEnd());
    }
    this.closed = true;
    for (const listener of this.listeners) {
      listener.close();
    }
    if (this.listeners.size === 0) {
      this.scheduleCleanup();
    }
  }

  private async startProcessing(): Promise<void> {
    try {
      await this.consumeSource();
      this.emitParts(this.mapper.finalizeOnStreamEnd());
    } catch (error) {
      this.emitParts(this.mapper.handleError(error));
    } finally {
      this.finalizeStream();
    }
  }

  private recordChunk(chunk: EncodedChunk): void {
    const id = `${this.id}:${this.sequence}`;
    const payload = encodeChunk(chunk);
    const stored: StoredChunk = {
      sequence: this.sequence,
      payload,
      chunk,
    };
    this.sequence += 1;
    this.events.push(stored);
    debugLog('emit', { id, code: chunk.code, value: chunk.value });
    for (const listener of this.listeners) {
      listener.pushImmediate(stored);
    }
  }

  pullEvent(index: number): StoredChunk | undefined {
    return this.events[index];
  }

  isClosed(): boolean {
    return this.closed;
  }
}

class SessionSubscription {
  private nextIndex: number;
  private closed = false;

  constructor(
    private readonly session: AssistantDataStreamSession,
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    startIndex: number
  ) {
    this.nextIndex = startIndex;
  }

  flushExisting(): void {
    while (!this.closed) {
      const chunk = this.session.pullEvent(this.nextIndex);
      if (!chunk) {
        break;
      }
      this.controller.enqueue(chunk.payload);
      this.nextIndex += 1;
    }
    if (this.session.isClosed()) {
      this.close();
    }
  }

  pushImmediate(event: StoredChunk): void {
    if (this.closed) {
      return;
    }
    if (event.sequence < this.nextIndex) {
      return;
    }
    if (event.sequence > this.nextIndex) {
      while (!this.closed && event.sequence > this.nextIndex) {
        const queued = this.session.pullEvent(this.nextIndex);
        if (!queued) {
          break;
        }
        this.controller.enqueue(queued.payload);
        this.nextIndex += 1;
      }
    }
    if (!this.closed) {
      this.controller.enqueue(event.payload);
      this.nextIndex = event.sequence + 1;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.controller.close();
    } catch (closeError) {
      // Controller close errors during subscription teardown are non-critical
      // but logged for debugging silent failures
      if (closeError instanceof Error) {
        console.warn('Stream controller close failed:', closeError.message);
      }
    }
    this.session.removeSubscription(this);
  }
}

export class AssistantDataStreamSessionManager {
  private readonly sessions = new Map<string, AssistantDataStreamSession>();

  constructor(private readonly cleanupDelayMs: number = DEFAULT_CLEANUP_DELAY_MS) {}

  getByEventId(eventId: string | null | undefined): AssistantDataStreamSession | undefined {
    const parsed = parseEventId(eventId);
    if (!parsed) {
      return;
    }
    return this.sessions.get(parsed.sessionId);
  }

  create(
    source: AsyncIterable<StreamChunk>,
    options: AssistantDataStreamSessionOptions = {}
  ): AssistantDataStreamSession {
    const sessionOptions: AssistantDataStreamSessionOptions = {
      ...options,
      cleanupDelayMs: options.cleanupDelayMs ?? this.cleanupDelayMs,
    };
    const session = new AssistantDataStreamSession(
      source,
      (sessionId) => {
        this.sessions.delete(sessionId);
      },
      sessionOptions
    );
    this.sessions.set(session.id, session);
    return session;
  }
}

const assistantDataStreamSessions = new AssistantDataStreamSessionManager();

export function resolveDataStreamSession(
  eventId: string | null | undefined
): AssistantDataStreamSession | undefined {
  return assistantDataStreamSessions.getByEventId(eventId);
}

function createRandomId(prefix: string): string {
  const globalScope = globalThis as {
    crypto?: { randomUUID?: () => string };
  };
  if (globalScope.crypto && typeof globalScope.crypto.randomUUID === 'function') {
    return `${prefix}_${globalScope.crypto.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${random}`;
}

export { assistantDataStreamSessions };
