import type { AssistantDiscoveredRun } from '@brainstrike/assistant-contract/assistant-stream-session';
import { createLogger } from '@brainstrike/logging';
import { generateUUID } from '@brainstrike/utils';
import type { StreamChunk } from '../types';
import { type EncodedChunk, encodeChunk, type StoredChunk } from './data-stream-codes';
import {
  DataStreamMapper,
  type DataStreamTerminalOutcome,
  type OutputLimitContext,
} from './data-stream-mapper';
import { parseEventId } from './session-manager';
import { SessionSubscription } from './session-subscription';

export interface AssistantDataStreamSessionOptions {
  cleanupDelayMs?: number;
  discovery?: {
    readonly resourceId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly parentMessageId?: string | null;
    readonly inputMessage: AssistantDiscoveredRun['inputMessage'];
    readonly inputParentMessageId: string | null;
    readonly actionReplay?: AssistantDiscoveredRun['actionReplay'];
  };
  messageId?: string;
  outputLimitContext?: OutputLimitContext;
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
  readonly discovery: AssistantDataStreamSessionOptions['discovery'];
  private readonly events: StoredChunk[] = [];
  private readonly listeners = new Set<SessionSubscription>();
  private readonly mapper: DataStreamMapper;
  private readonly cleanupDelayMs: number;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private sequence = 0;
  private closed = false;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly source: AsyncIterable<StreamChunk>,
    private readonly onCleanup: (sessionId: string) => void,
    options?: AssistantDataStreamSessionOptions
  ) {
    const resolved = options ?? {};
    this.id = resolved.sessionId ?? createRandomId('sess');
    this.messageId = resolved.messageId ?? createRandomId('msg');
    this.discovery = resolved.discovery;
    this.cleanupDelayMs = resolved.cleanupDelayMs ?? DEFAULT_CLEANUP_DELAY_MS;
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.mapper = new DataStreamMapper(this.messageId, resolved.outputLimitContext);
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

    let subscription: SessionSubscription | undefined;
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => {
        subscription?.cancel();
      },
      start: (controller) => {
        subscription = new SessionSubscription(this, controller, startIndex);
        this.listeners.add(subscription);
        subscription.flushExisting();
        if (this.closed) {
          queueMicrotask(() => subscription?.close());
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

  whenClosed(): Promise<void> {
    return this.closedPromise;
  }

  getTerminalOutcome(): DataStreamTerminalOutcome {
    return this.mapper.getTerminalOutcome();
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
    // The session owns source consumption. Individual HTTP responses are
    // subscribers and may detach without terminating the agent run.
    for await (const chunk of this.source) {
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
    this.resolveClosed();
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

  /** Exact-scope replay discovery across renderer reloads before message hydration. */
  findLatestByScope(resourceId: string, threadId: string): AssistantDiscoveredRun | null {
    const matching = [...this.sessions.values()].filter(
      (session) =>
        session.discovery?.resourceId === resourceId && session.discovery.threadId === threadId
    );
    const active = matching.filter((candidate) => !candidate.isClosed());
    if (active.length > 1) {
      throw new Error('Multiple active assistant sessions own the same thread.');
    }
    const session = active[0] ?? matching.at(-1);
    const discovery = session?.discovery;
    if (!(session && discovery)) {
      return null;
    }
    return {
      assistantMessageId: session.messageId,
      eventId: `${session.id}:-1`,
      ...(discovery.parentMessageId === undefined
        ? {}
        : { parentMessageId: discovery.parentMessageId }),
      inputMessage: discovery.inputMessage,
      inputParentMessageId: discovery.inputParentMessageId,
      ...(discovery.actionReplay ? { actionReplay: discovery.actionReplay } : {}),
      runId: discovery.runId,
      state: session.isClosed() ? 'closed' : 'active',
    };
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

/**
 * Create one response without adding the stream to the process-local replay
 * registry. Hosted functions reject Last-Event-ID and cannot promise affinity,
 * so retaining their full output in the global session map only wastes memory.
 */
export function createStatelessAssistantDataStreamResponse(
  source: AsyncIterable<StreamChunk>,
  options: Omit<AssistantDataStreamSessionOptions, 'cleanupDelayMs'> = {}
): Response {
  const session = new AssistantDataStreamSession(source, () => {}, {
    ...options,
    cleanupDelayMs: 0,
  });
  return session.createResponse();
}

export function resolveDataStreamSession(
  eventId: string | null | undefined
): AssistantDataStreamSession | undefined {
  return assistantDataStreamSessions.getByEventId(eventId);
}

export function createRandomId(prefix: string): string {
  return `${prefix}_${generateUUID()}`;
}

export { assistantDataStreamSessions };
