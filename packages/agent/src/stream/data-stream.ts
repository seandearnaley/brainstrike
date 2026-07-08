import { createLogger, generateUUID } from '@brainstrike/utils';
import type { StreamChunk } from '../types';
import { type EncodedChunk, encodeChunk, type StoredChunk } from './data-stream-codes';
import { DataStreamMapper } from './data-stream-mapper';
import { parseEventId } from './session-manager';
import { SessionSubscription } from './session-subscription';

export interface AssistantDataStreamSessionOptions {
  cleanupDelayMs?: number;
  messageId?: string;
  sessionId?: string;
}

interface CreateResponseOptions {
  headers?: HeadersInit;
  resumeFromEventId?: string | null;
}

const logger = createLogger('AgentDataStream');
const DEFAULT_CLEANUP_DELAY_MS = 2 * 60 * 1000;
const STREAM_DEBUG_ENABLED = Boolean(process.env['BRAINSTRIKE_DEBUG_STREAM']);

function debugLog(stage: string, payload: unknown): void {
  if (STREAM_DEBUG_ENABLED) {
    logger.debug(`[brainstrike:data-stream] ${stage}`, payload);
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
    this.mapper = new DataStreamMapper(this.messageId);
    for (const chunk of this.mapper.initialChunks()) {
      this.recordChunk(chunk);
    }
    void this.startProcessing();
  }

  createResponse(options: CreateResponseOptions = {}): Response {
    const { resumeFromEventId, headers } = options;
    const startIndex = this.resolveStartIndex(resumeFromEventId);
    if (STREAM_DEBUG_ENABLED && resumeFromEventId) {
      debugLog('resume', { resumeFromEventId, session: this.id, startIndex });
    }

    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', 'text/plain; charset=utf-8');
    responseHeaders.set('Cache-Control', 'no-store');
    responseHeaders.set('Connection', 'close');
    responseHeaders.set('x-vercel-ai-data-stream', 'v1');
    if (headers) {
      const init = new Headers(headers);
      for (const [key, value] of init.entries()) {
        if (!responseHeaders.has(key)) {
          responseHeaders.set(key, value);
        }
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      cancel: () => {
        // Called when client cancels response stream (e.g., user stops generation)
        // Sets abort flag to stop source consumption in consumeSource() loop
        // This prevents backend from continuing to process after client disconnects
        this.aborted = true;
        this.cancelAllListeners();
      },
      start: (controller) => {
        const subscription = new SessionSubscription(this, controller, startIndex);
        this.listeners.add(subscription);
        subscription.flushExisting();
        if (this.closed) {
          queueMicrotask(() => subscription.close());
        }
      },
    });

    return new Response(stream, { headers: responseHeaders, status: 200 });
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
      chunk,
      payload,
      sequence: this.sequence,
    };
    this.sequence += 1;
    this.events.push(stored);
    debugLog('emit', { code: chunk.code, id, value: chunk.value });
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

export function createRandomId(prefix: string): string {
  return `${prefix}_${generateUUID()}`;
}

export { assistantDataStreamSessions };
