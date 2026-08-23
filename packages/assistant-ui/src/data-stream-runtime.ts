import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  CreateResumeRunConfig,
  LocalRuntimeOptionsBase,
  ThreadMessage,
} from '@assistant-ui/react';
import { useLocalRuntime } from '@assistant-ui/react';
import {
  ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES,
  type AssistantActiveRunSession,
  AssistantAttachmentValidationError,
  dataUrlByteLength,
  type RuntimeTransportImageElision,
} from '@brainstrike/assistant-contract';
import { CONTEXT_BREAKDOWN_DATA_NAME } from '@brainstrike/assistant-contract/context-breakdown';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract/run-events';
import { CHILD_RUN_USAGE_DATA_NAME } from '@brainstrike/assistant-contract/run-usage';
import { createAssistantRequestEnvelope } from '@brainstrike/assistant-wire';
import { createLogger } from '@brainstrike/logging';
import { sliceCodePoints } from '@brainstrike/utils/string-utils';
import type { AssistantStreamChunk } from 'assistant-stream';
import {
  AssistantMessageAccumulator,
  DataStreamDecoder,
  toGenericMessages,
  // assistant-stream is pinned in lockstep with @assistant-ui/core's own
  // range (0.3.37 as of the 0.15.13 upgrade): two coexisting assistant-stream
  // instances make this import's `Tool` type structurally incompatible with
  // the one inside @assistant-ui/core. Tool result streaming is still exported
  // behind the unstable API surface.
  unstable_toolResultStream,
} from 'assistant-stream';
import { asAsyncIterableStream } from 'assistant-stream/utils';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  excludeApprovalActionMessages,
  isActionRunConfig,
  isApprovalActionMessage,
} from './approval-action-message';
import {
  type AssistantReplayMessageIdentityRef,
  remapAssistantReplayHistoryItem,
  useAssistantRunReattachment,
} from './assistant-run-reattachment';
import { insulateAssistantStreamPipeline } from './stream-insulation';

export { excludeApprovalActionMessages, isApprovalActionMessage };

type HeadersValue = Headers | Record<string, string>;
const logger = createLogger('BrainstrikeDataStreamRuntime');
const MAX_HTTP_ERROR_RESPONSE_TEXT_CHARS = 4000;
export const DEFAULT_ASSISTANT_REQUEST_PREPARATION_TIMEOUT_MS = 30_000;

export interface AssistantUsage {
  readonly billedCostUsd?: number;
  /** Anthropic prompt-cache write tokens; present only when reported. */
  readonly cacheCreationInputTokens?: number;
  /** Anthropic prompt-cache read tokens; present only when reported. */
  readonly cacheReadInputTokens?: number;
  /** Latest provider-step prompt size for context occupancy. */
  readonly contextInputTokens?: number;
  /** Latest provider-step completion size for next-prompt occupancy. */
  readonly contextOutputTokens?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type BrainstrikeDataStreamRuntimeOptions = {
  activeRunSession?: AssistantActiveRunSession;
  api: string;
  body?:
    | ((
        abortSignal: AbortSignal,
        context: PrepareRequestBodyContext
      ) => Promise<Record<string, unknown> | undefined>)
    | Record<string, unknown>;
  credentials?: RequestCredentials;
  headers?: ((abortSignal: AbortSignal) => Promise<HeadersValue>) | HeadersValue;
  /**
   * Called once per streamed chunk while the assistant response is in flight.
   * Used as a liveness signal (e.g. renewing foreground-activity leases).
   * Hook failures are logged and must never break the stream.
   */
  onActivity?: () => void;
  onCancel?: () => void;
  onError?: (error: Error) => void;
  onFinish?: (message: ThreadMessage) => void;
  /** Reports replay-only failures so the active session can schedule a bounded retry. */
  onReplayError?: (error: Error) => void;
  onResponse?: (response: Response) => Promise<void> | void;
  /**
   * Visible local-model warmup that runs before the bounded request-input
   * phase. It has no absolute deadline because it may download model files,
   * but Stop always detaches the request through the supplied signal.
   */
  prepareRequestWarmup?: (abortSignal: AbortSignal) => Promise<void>;
  /**
   * Exact UTF-8 ceiling for the serialized request body. Hosted Web sets this
   * below its function platform's ingress limit so oversized turns fail in the
   * renderer before fetch; desktop/local transports may omit it.
   */
  requestBodyLimitBytes?: number;
  /**
   * Combined deadline for async auth-header and request-body preparation.
   * The preparation signal aborts on Stop or timeout so no late result can
   * advance into fetch after the run has reached a terminal state.
   */
  requestPreparationTimeoutMs?: number;
  replayRetryToken?: number;
  resumeApi?: string;
  /**
   * Called with the RAW payload of each `brainstrike.context-breakdown` data
   * part (run-start prompt breakdown). The payload is deliberately `unknown`:
   * the consumer parses it with the contract guard so a malformed part is
   * surfaced as `{ invalid: true }`, never coerced here. Same non-throwing
   * consumer contract as `onUsage`.
   */
  onContextBreakdown?: (data: unknown) => void;
  /**
   * Called with the RAW payload of each `brainstrike.child-run-usage` data
   * part (a subagent / OM cycle's usage, already durably persisted by the
   * desktop server — BST-953). The consumer validates with the contract guard
   * and refreshes its thread-total readout; it must never write usage rows.
   */
  onChildRunUsage?: (data: unknown) => void;
  /**
   * Called with each `run.step.finished` run event's billed step usage while
   * the run streams (BST-953 live tick). Steps ACCUMULATE — the consumer sums
   * them for the in-flight run and drops the sum once durable usage lands.
   */
  onStepUsage?: (step: { inputTokens: number; outputTokens: number }) => void;
  /**
   * Called when a finish-message chunk reports provider token usage.
   * The callback contract requires non-throwing consumers — our consumer
   * is a zustand setState which is safe.
   */
  onUsage?: (usage: AssistantUsage) => void;
} & Omit<LocalRuntimeOptionsBase, 'adapters'> & {
    adapters?: Omit<LocalRuntimeOptionsBase['adapters'], 'chatModel'>;
  };
type BrainstrikeDataStreamRuntimeOptionsSource =
  | BrainstrikeDataStreamRuntimeOptions
  | (() => BrainstrikeDataStreamRuntimeOptions);

export class AssistantStreamReplayUnavailableError extends Error {
  override readonly name = 'AssistantStreamReplayUnavailableError';
}

export class AssistantRequestPreparationTimeoutError extends Error {
  override readonly name = 'AssistantRequestPreparationTimeoutError';
}

function requireRequestPreparationTimeoutMs(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `Assistant request preparation timeout must be a positive safe integer; received ${String(timeoutMs)}.`
    );
  }
  return timeoutMs;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The assistant request was aborted.', 'AbortError');
}

/** Per-run context handed to a function-form `body` provider. */
export interface PrepareRequestBodyContext {
  /**
   * The id of the turn's triggering user message — the last REAL user message
   * in the thread, with approval/suspend action echoes excluded (they are UI
   * bookkeeping with no durable row). Every leg of one turn (initial send,
   * approval/suspend resumes) resolves the SAME id, which is what lets
   * `createThreadRun` persist a run↔turn link (BST-1163). `null` when the
   * thread has no real user message.
   */
  readonly turnAnchorMessageId: string | null;
}

/**
 * The turn anchor for a run leg — see
 * {@link PrepareRequestBodyContext.turnAnchorMessageId}. Mirrors the desktop
 * server's `resolveTurnAnchorMessageId` (snapshot-turn-boundaries.ts) with the
 * renderer-side extra of skipping action echoes, which never reach the server.
 */
export function resolveTurnAnchorMessageId(messages: readonly ThreadMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role === 'user' && !isApprovalActionMessage(candidate)) {
      return candidate.id;
    }
  }
  return null;
}

const NO_BODY_CONTEXT: PrepareRequestBodyContext = { turnAnchorMessageId: null };

function prepareRequestInputs(
  options: Pick<BrainstrikeDataStreamRuntimeOptions, 'body' | 'headers'>,
  callerSignal: AbortSignal,
  timeoutMs: number,
  bodyContext: PrepareRequestBodyContext = NO_BODY_CONTEXT
): Promise<{
  readonly headersValue: HeadersValue | undefined;
  readonly rawBodyValue: Record<string, unknown> | undefined;
}> {
  const preparationTimeoutMs = requireRequestPreparationTimeoutMs(timeoutMs);
  const preparationController = new AbortController();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const settle = (
      outcome:
        | {
            readonly status: 'fulfilled';
            readonly value: {
              readonly headersValue: HeadersValue | undefined;
              readonly rawBodyValue: Record<string, unknown> | undefined;
            };
          }
        | { readonly reason: unknown; readonly status: 'rejected' }
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      callerSignal.removeEventListener('abort', abortFromCaller);
      if (outcome.status === 'fulfilled') {
        resolve(outcome.value);
        return;
      }
      reject(outcome.reason);
    };
    const abortFromCaller = (): void => {
      const reason = abortReason(callerSignal);
      settle({ reason, status: 'rejected' });
      preparationController.abort(reason);
    };
    timeoutId = setTimeout(() => {
      const error = new AssistantRequestPreparationTimeoutError(
        `Assistant request preparation timed out after ${preparationTimeoutMs}ms.`
      );
      settle({ reason: error, status: 'rejected' });
      preparationController.abort(error);
    }, preparationTimeoutMs);

    if (callerSignal.aborted) {
      abortFromCaller();
      return;
    }
    callerSignal.addEventListener('abort', abortFromCaller, { once: true });

    void Promise.resolve()
      .then(async () => {
        const headersValue =
          typeof options.headers === 'function'
            ? await options.headers(preparationController.signal)
            : options.headers;
        preparationController.signal.throwIfAborted();
        const rawBodyValue =
          typeof options.body === 'function'
            ? await options.body(preparationController.signal, bodyContext)
            : options.body;
        preparationController.signal.throwIfAborted();
        return { headersValue, rawBodyValue };
      })
      .then(
        (value) => settle({ status: 'fulfilled', value }),
        (reason: unknown) => settle({ reason, status: 'rejected' })
      );
  });
}

function runAbortableRequestWarmup(
  warmup: (abortSignal: AbortSignal) => Promise<void>,
  abortSignal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (
      outcome:
        | { readonly status: 'fulfilled' }
        | { readonly reason: unknown; readonly status: 'rejected' }
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      abortSignal.removeEventListener('abort', abort);
      if (outcome.status === 'fulfilled') {
        resolve();
        return;
      }
      reject(outcome.reason);
    };
    const abort = (): void => {
      settle({ reason: abortReason(abortSignal), status: 'rejected' });
    };
    if (abortSignal.aborted) {
      abort();
      return;
    }
    abortSignal.addEventListener('abort', abort, { once: true });
    void Promise.resolve()
      .then(() => warmup(abortSignal))
      .then(
        () => settle({ status: 'fulfilled' }),
        (reason: unknown) => settle({ reason, status: 'rejected' })
      );
  });
}

function assertSerializedRequestBodyWithinLimit(body: string, limitBytes: number): void {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    throw new Error(
      `Assistant transport request-body limit must be a positive safe integer; received ${String(limitBytes)}.`
    );
  }
  if (new TextEncoder().encode(body).byteLength > limitBytes) {
    throw new Error(`Assistant request body exceeds the ${limitBytes}-byte transport limit.`);
  }
}

interface GenericTextPart {
  readonly text?: unknown;
  readonly type?: unknown;
}

interface GenericMessageLike {
  readonly content?: unknown;
  readonly role?: unknown;
}

function requireTransportUserMessageId(message: ThreadMessage): string {
  const id = message.id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Assistant user message is missing its assistant-ui message ID.');
  }
  return id;
}

function toContentParts(content: unknown): readonly GenericTextPart[] {
  if (Array.isArray(content)) {
    return content as readonly GenericTextPart[];
  }
  if (typeof content === 'string') {
    return [{ text: content, type: 'text' }];
  }
  if (content && typeof content === 'object') {
    return [content as GenericTextPart];
  }
  return [];
}

function toPartRecord(part: GenericTextPart): Record<string, unknown> {
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    return {};
  }
  return part as Record<string, unknown>;
}

function requireStringField(part: GenericTextPart, field: string, context: string): string {
  const value = toPartRecord(part)[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${context}: missing ${field}.`);
  }
  return value;
}

function optionalStringField(part: GenericTextPart, field: string): string | undefined {
  const value = toPartRecord(part)[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toUserFilePart(part: GenericTextPart): {
  readonly data: string;
  readonly mediaType: string | undefined;
  readonly type: 'file';
} {
  const record = toPartRecord(part);
  return {
    data: String(record['data'] ?? ''),
    mediaType: optionalStringField(part, 'mediaType'),
    type: 'file',
  };
}

function toHostedTextPart(part: GenericTextPart): { readonly text: string } {
  const value = toPartRecord(part)['text'];
  return { text: typeof value === 'string' ? value : '' };
}

function isMemoryBackedRequest(bodyValue: Record<string, unknown> | undefined): boolean {
  const data = bodyValue?.['data'];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  return Boolean((data as { memory?: unknown }).memory);
}

export function extractTransportBodyData(
  bodyValue: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!bodyValue) {
    return {};
  }

  const unsupportedKeys = Object.keys(bodyValue).filter((key) => key !== 'data');
  if (unsupportedKeys.length > 0) {
    throw new Error(
      `Assistant runtime body only supports top-level data; unsupported field(s): ${unsupportedKeys.join(', ')}. Put app-specific values under data.`
    );
  }

  return Object.hasOwn(bodyValue, 'data') ? { data: bodyValue['data'] } : {};
}

function assertSupportedAssistantUiRequestContext(
  context: ChatModelRunOptions['context'],
  state: unknown
): void {
  const unsupportedFields: string[] = [];
  if (Object.keys(context.callSettings ?? {}).length > 0) {
    unsupportedFields.push('callSettings');
  }
  if (Object.keys(context.config ?? {}).length > 0) {
    unsupportedFields.push('config');
  }
  if (state !== undefined && state !== null) {
    unsupportedFields.push('state');
  }
  if (context.system) {
    unsupportedFields.push('system');
  }
  if (Object.keys(context.tools ?? {}).length > 0) {
    unsupportedFields.push('tools');
  }
  if (unsupportedFields.length === 0) {
    return;
  }
  throw new Error(
    `Brainstrike assistant transport does not support assistant-ui field(s): ${unsupportedFields.join(', ')}.`
  );
}

function appendBoundedHttpErrorText(
  currentText: string,
  nextText: string
): { readonly text: string; readonly truncated: boolean } {
  if (!nextText) {
    return { text: currentText, truncated: false };
  }
  const remainingChars = MAX_HTTP_ERROR_RESPONSE_TEXT_CHARS - currentText.length;
  if (remainingChars <= 0) {
    return { text: currentText, truncated: true };
  }
  if (nextText.length <= remainingChars) {
    return { text: `${currentText}${nextText}`, truncated: false };
  }
  return {
    text: `${currentText}${sliceCodePoints(nextText, remainingChars)}`,
    truncated: true,
  };
}

async function readBoundedHttpErrorResponseText(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;
  try {
    while (!truncated) {
      const { done, value } = await reader.read();
      const decodedText = done ? decoder.decode() : decoder.decode(value, { stream: true });
      const appendResult = appendBoundedHttpErrorText(text, decodedText);
      text = appendResult.text;
      truncated = appendResult.truncated;
      if (done || !truncated) {
        if (done) {
          break;
        }
        continue;
      }
      try {
        await reader.cancel();
      } catch {
        // Preserve the HTTP status failure as the primary error.
      }
      break;
    }
  } finally {
    reader.releaseLock();
  }
  if (!truncated) {
    return text;
  }
  return `${text}...[truncated]`;
}

/**
 * When Mastra memory is active, Mastra owns durable conversation history.
 * The transport sends system context plus the current turn, starting at the
 * latest user message, so hosted providers do not receive duplicate history.
 */
export function selectTransportMessagesForMastraMemory(
  messages: readonly ThreadMessage[],
  bodyValue: Record<string, unknown> | undefined
): readonly ThreadMessage[] {
  if (!isMemoryBackedRequest(bodyValue)) {
    return messages;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      const systemMessages = messages
        .slice(0, index)
        .filter((message) => message.role === 'system');
      return [...systemMessages, ...messages.slice(index)];
    }
  }
  // Pre-seeded threads without a user turn cannot be safely compacted by the
  // current-turn rule, so preserve the full payload instead of dropping context.
  return messages;
}

function toLanguageModelMessages(messages: readonly ThreadMessage[]): unknown[] {
  const genericMessages = messages.flatMap((sourceMessage) =>
    toGenericMessages([sourceMessage] as Parameters<typeof toGenericMessages>[0]).map(
      (message) => ({ message, sourceMessage })
    )
  );
  return genericMessages.map(({ message, sourceMessage }) => {
    const item = message as GenericMessageLike;
    const content = toContentParts(item.content);
    switch (item.role) {
      case 'system':
        return {
          content: content.map((part) => (part.type === 'text' ? toHostedTextPart(part) : part)),
          role: 'system',
        };
      case 'user':
        return {
          content: content.map((part) =>
            part.type === 'text' ? toHostedTextPart(part) : toUserFilePart(part)
          ),
          id: requireTransportUserMessageId(sourceMessage),
          role: 'user',
        };
      case 'assistant':
        return {
          content: content.map((part) =>
            part.type === 'text'
              ? toHostedTextPart(part)
              : {
                  input: toPartRecord(part)['args'],
                  toolCallId: requireStringField(part, 'toolCallId', 'assistant tool-call part'),
                  toolName: requireStringField(part, 'toolName', 'assistant tool-call part'),
                  type: 'tool-call',
                }
          ),
          role: 'assistant',
        };
      case 'tool':
        return {
          content: content.map((part) => {
            const record = toPartRecord(part);
            return {
              output: record['isError']
                ? { type: 'error-json', value: record['result'] }
                : { type: 'json', value: record['result'] },
              toolCallId: requireStringField(part, 'toolCallId', 'tool result part'),
              toolName: optionalStringField(part, 'toolName'),
              type: 'tool-result',
            };
          }),
          role: 'tool',
        };
      default:
        return { content, role: item.role };
    }
  });
}

function withTransportCompactionMetadata(
  bodyValue: Record<string, unknown> | undefined,
  originalMessageCount: number,
  sentMessageCount: number
): Record<string, unknown> | undefined {
  if (!isMemoryBackedRequest(bodyValue) || originalMessageCount === sentMessageCount) {
    return bodyValue;
  }
  const data = bodyValue?.['data'];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return bodyValue;
  }
  return {
    ...bodyValue,
    data: {
      ...data,
      transportCompaction: {
        originalMessageCount,
        sentMessageCount,
        strategy: 'mastra-memory-current-turn',
      },
    },
  };
}

export type TransportImageElision = RuntimeTransportImageElision;

interface WireImagePartRef {
  readonly bytes: number;
  readonly fileCount: number;
  readonly mediaType: string | undefined;
  readonly messageIndex: number;
  readonly ordinal: number;
  readonly partIndex: number;
  readonly unmeasurable: boolean;
}

function wireContentOf(wireMessage: unknown): readonly unknown[] {
  if (!wireMessage || typeof wireMessage !== 'object') {
    return [];
  }
  const content = (wireMessage as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function isWireImagePart(value: unknown): value is Record<string, unknown> & { data: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record['type'] === 'file' && typeof record['data'] === 'string';
}

function isWireUserMessage(wireMessage: unknown): boolean {
  return (
    Boolean(wireMessage) &&
    typeof wireMessage === 'object' &&
    (wireMessage as { role?: unknown }).role === 'user'
  );
}

/**
 * Decoded byte length of one wire image part, from the shared attachment
 * contract. CURRENT-turn parts measure strictly — the composer just produced
 * them, so an unmeasurable payload is a real bug and THROWS. HISTORY parts
 * degrade instead of aborting the send: one malformed old attachment must not
 * lock the user out of every later turn in the thread, so it returns
 * `undefined` and the caller elides the part with a visible note.
 */
function measureWireImagePartBytes(data: string, isCurrentTurn: boolean): number | undefined {
  if (isCurrentTurn) {
    return dataUrlByteLength(data);
  }
  try {
    return dataUrlByteLength(data);
  } catch (error) {
    if (error instanceof AssistantAttachmentValidationError) {
      return;
    }
    throw error;
  }
}

/**
 * Measure every inline image (file) part carried by user wire messages.
 * See {@link measureWireImagePartBytes} for the strict-current-turn /
 * degrade-history measurement contract.
 */
function collectWireImagePartRefs(
  wireMessages: readonly unknown[],
  lastUserIndex: number
): WireImagePartRef[] {
  const refs: WireImagePartRef[] = [];
  for (let messageIndex = 0; messageIndex < wireMessages.length; messageIndex += 1) {
    if (!isWireUserMessage(wireMessages[messageIndex])) {
      continue;
    }
    const content = wireContentOf(wireMessages[messageIndex]);
    const filePartIndices: number[] = [];
    for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
      if (isWireImagePart(content[partIndex])) {
        filePartIndices.push(partIndex);
      }
    }
    for (let ordinalIndex = 0; ordinalIndex < filePartIndices.length; ordinalIndex += 1) {
      const partIndex = filePartIndices[ordinalIndex] as number;
      const part = content[partIndex] as Record<string, unknown> & { data: string };
      const bytes = measureWireImagePartBytes(part.data, messageIndex >= lastUserIndex);
      refs.push({
        bytes: bytes ?? 0,
        fileCount: filePartIndices.length,
        mediaType: typeof part['mediaType'] === 'string' ? part['mediaType'] : undefined,
        messageIndex,
        ordinal: ordinalIndex + 1,
        partIndex,
        unmeasurable: bytes === undefined,
      });
    }
  }
  return refs;
}

function findLastWireUserIndex(wireMessages: readonly unknown[]): number {
  for (let index = wireMessages.length - 1; index >= 0; index -= 1) {
    if (isWireUserMessage(wireMessages[index])) {
      return index;
    }
  }
  return -1;
}

/**
 * Newest-first, recency-monotonic selection: history images spend whatever
 * budget the current turn leaves, and once one image does not fit, every
 * OLDER image is elided with it — the model never sees an older image while
 * missing a newer one. Unmeasurable history parts are always elided but stay
 * outside the budget walk: an invalid old payload neither ships nor forces
 * valid neighbors off the wire.
 */
function selectElidedHistoryImageRefs(
  refs: readonly WireImagePartRef[],
  lastUserIndex: number
): WireImagePartRef[] {
  const currentTurnBytes = refs
    .filter((ref) => ref.messageIndex >= lastUserIndex)
    .reduce((total, ref) => total + ref.bytes, 0);
  const history = refs
    .filter((ref) => ref.messageIndex < lastUserIndex)
    .sort((a, b) => b.messageIndex - a.messageIndex || a.partIndex - b.partIndex);
  let remainingBytes = ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES - currentTurnBytes;
  const elided: WireImagePartRef[] = [];
  let cutoff = false;
  for (const ref of history) {
    if (ref.unmeasurable) {
      elided.push(ref);
      continue;
    }
    if (!cutoff && ref.bytes <= remainingBytes) {
      remainingBytes -= ref.bytes;
      continue;
    }
    cutoff = true;
    elided.push(ref);
  }
  return elided;
}

function formatImageByteSize(bytes: number): string {
  const kilobyte = 1024;
  const megabyte = kilobyte * kilobyte;
  if (bytes >= megabyte) {
    return `${(bytes / megabyte).toFixed(1)}MB`;
  }
  if (bytes >= kilobyte) {
    return `${Math.round(bytes / kilobyte)}KB`;
  }
  return `${bytes}B`;
}

function buildImageElisionNote(ref: WireImagePartRef): string {
  if (ref.unmeasurable) {
    return `[Image attachment ${ref.ordinal} of ${ref.fileCount} (${ref.mediaType ?? 'image'}) from this earlier message is not an inline base64 data URL, so it could not be measured for resending and was omitted from the request. Ask the user to re-attach it if it is needed again.]`;
  }
  const described = `${ref.mediaType ?? 'image'}, ${formatImageByteSize(ref.bytes)}`;
  return `[Image attachment ${ref.ordinal} of ${ref.fileCount} (${described}) from this earlier message was omitted from the request to keep it within the transport size limit. The image is unchanged in the conversation; ask the user to re-attach it if it is needed again.]`;
}

function replaceElidedWireImageParts(
  wireMessages: readonly unknown[],
  elided: readonly WireImagePartRef[]
): unknown[] {
  const refsByMessage = new Map<number, Map<number, WireImagePartRef>>();
  for (const ref of elided) {
    const partMap = refsByMessage.get(ref.messageIndex) ?? new Map<number, WireImagePartRef>();
    partMap.set(ref.partIndex, ref);
    refsByMessage.set(ref.messageIndex, partMap);
  }
  return wireMessages.map((wireMessage, messageIndex) => {
    const partMap = refsByMessage.get(messageIndex);
    if (!partMap) {
      return wireMessage;
    }
    const content = wireContentOf(wireMessage).map((part, partIndex) => {
      const ref = partMap.get(partIndex);
      return ref ? { text: buildImageElisionNote(ref) } : part;
    });
    return { ...(wireMessage as Record<string, unknown>), content };
  });
}

/**
 * Bound the inline image payload of one outgoing request to the SAME combined
 * cap the composer enforces per message
 * ({@link ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES}) — the number the 16MB
 * request body limit is sized against. Without this, non-memory-backed
 * transports that resend full history accumulate every prior turn's base64
 * image bodies until the body limit rejects the request.
 *
 * The current turn's attachments always ship (the server validates them
 * against the same cap); history images spend the remainder newest-first. A
 * history part that cannot be measured (not an inline base64 data URL) is
 * always elided with its own note rather than failing the send — one
 * malformed old attachment must not block every later turn in the thread.
 * Elision is WIRE-ONLY and LOUD: the thread state and persisted record keep
 * the image, and each elided part is replaced with a visible text note so the
 * model knows exactly what it can no longer see. Callers must surface the
 * returned elision stats (request metadata + log), never drop them.
 */
export function boundResentImageHistory(wireMessages: readonly unknown[]): {
  readonly elision: TransportImageElision | undefined;
  readonly messages: readonly unknown[];
} {
  const lastUserIndex = findLastWireUserIndex(wireMessages);
  const refs = collectWireImagePartRefs(wireMessages, lastUserIndex);
  const elided = selectElidedHistoryImageRefs(refs, lastUserIndex);
  if (elided.length === 0) {
    return { elision: undefined, messages: wireMessages };
  }
  const elidedImageBytes = elided.reduce((total, ref) => total + ref.bytes, 0);
  const totalImageBytes = refs.reduce((total, ref) => total + ref.bytes, 0);
  const unmeasurableImageCount = elided.filter((ref) => ref.unmeasurable).length;
  return {
    elision: {
      elidedImageBytes,
      elidedImageCount: elided.length,
      keptImageBytes: totalImageBytes - elidedImageBytes,
      strategy: 'newest-first-combined-image-budget',
      ...(unmeasurableImageCount > 0 ? { unmeasurableImageCount } : {}),
    },
    messages: replaceElidedWireImageParts(wireMessages, elided),
  };
}

/**
 * Mirror of {@link withTransportCompactionMetadata} for image elision: when
 * history image bodies were elided, the request's `data` records what was
 * dropped so the degradation is observable server-side, creating the `data`
 * object if the body had none.
 */
function withTransportImageElisionMetadata(
  bodyValue: Record<string, unknown> | undefined,
  elision: TransportImageElision | undefined
): Record<string, unknown> | undefined {
  if (!elision) {
    return bodyValue;
  }
  const data = bodyValue?.['data'];
  const dataRecord = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  return { ...bodyValue, data: { ...dataRecord, transportImageElision: elision } };
}

/**
 * Apply {@link boundResentImageHistory} to the outgoing wire messages and
 * surface any elision loudly in one step: a client warn log plus the
 * `transportImageElision` request metadata.
 */
function boundWireMessagesForTransport(
  wireMessages: readonly unknown[],
  bodyValue: Record<string, unknown> | undefined
): {
  readonly bodyValue: Record<string, unknown> | undefined;
  readonly messages: readonly unknown[];
} {
  const imageBound = boundResentImageHistory(wireMessages);
  if (imageBound.elision) {
    logger.warn('Elided older image attachment bodies from resent request history', {
      ...imageBound.elision,
    });
  }
  return {
    bodyValue: withTransportImageElisionMetadata(bodyValue, imageBound.elision),
    messages: imageBound.messages,
  };
}

/**
 * Approval/suspend ACTION messages are transport bookkeeping — exclude them
 * from every outbound payload BEFORE the memory compaction so a
 * regenerate-after-approval leg anchors on the previous REAL user message,
 * never the "Approved <tool>." echo. On the action leg itself (runConfig
 * carries the action) both resume routes ignore messages entirely, so ship an
 * EMPTY list. Thread state is untouched: the notice outcome locking and the
 * chip rendering still see the message.
 */
function resolveOutboundTransportMessages(
  messages: readonly ThreadMessage[],
  runConfig: unknown
): readonly ThreadMessage[] {
  if (isActionRunConfig(runConfig)) {
    return [];
  }
  return excludeApprovalActionMessages(messages);
}

/**
 * Pass-through tap that intercepts "message-finish" chunks to surface provider
 * token usage. The DataStreamDecoder outputs AssistantStreamChunk
 * (type: "message-finish") — not the raw DataStreamChunk (type: "d") — because
 * the decoder translates wire codes to semantic chunk types.
 * (Wire code reference: DataStreamCode.finishMessage = 'd' in packages/agent.)
 */
function buildUsageTap(
  onUsage: (usage: AssistantUsage) => void
): TransformStream<AssistantStreamChunk, AssistantStreamChunk> {
  return new TransformStream<AssistantStreamChunk, AssistantStreamChunk>({
    transform(chunk, controller) {
      const usage = readFinishUsage(chunk);
      if (usage) {
        onUsage(usage);
      }
      controller.enqueue(chunk);
    },
  });
}

/**
 * Pass-through tap that surfaces `brainstrike.context-breakdown` data parts.
 * The decoder maps an `aui-data` wire chunk to a `part-start` chunk carrying
 * `part: { type: 'data', name, data }` (assistant-stream appendData), so the
 * tap watches part-starts for the breakdown name and forwards the raw payload.
 */
function buildContextBreakdownTap(
  onContextBreakdown: (data: unknown) => void
): TransformStream<AssistantStreamChunk, AssistantStreamChunk> {
  return new TransformStream<AssistantStreamChunk, AssistantStreamChunk>({
    transform(chunk, controller) {
      if (chunk.type === 'part-start') {
        const part = (chunk as { part?: { data?: unknown; name?: unknown; type?: unknown } }).part;
        if (part?.type === 'data' && part.name === CONTEXT_BREAKDOWN_DATA_NAME) {
          onContextBreakdown(part.data);
        }
      }
      controller.enqueue(chunk);
    },
  });
}

/**
 * Pass-through tap for the thread-total readout (BST-953): surfaces
 * `brainstrike.child-run-usage` data parts and the billed step usage carried
 * by `run.step.finished` run events. Both ride `aui-data` wire chunks that the
 * decoder maps to `part-start` data parts (same shape the breakdown tap reads).
 */
function buildThreadUsageEventsTap(
  options: Pick<BrainstrikeDataStreamRuntimeOptions, 'onChildRunUsage' | 'onStepUsage'>
): TransformStream<AssistantStreamChunk, AssistantStreamChunk> {
  return new TransformStream<AssistantStreamChunk, AssistantStreamChunk>({
    transform(chunk, controller) {
      if (chunk.type === 'part-start') {
        const part = (chunk as { part?: { data?: unknown; name?: unknown; type?: unknown } }).part;
        if (part?.type === 'data' && part.name === CHILD_RUN_USAGE_DATA_NAME) {
          options.onChildRunUsage?.(part.data);
        } else if (part?.type === 'data' && part.name === ASSISTANT_RUN_EVENT_DATA_NAME) {
          const step = readStepFinishedUsage(part.data);
          if (step) {
            options.onStepUsage?.(step);
          }
        }
      }
      controller.enqueue(chunk);
    },
  });
}

/** Billed step usage from a `run.step.finished` run-event payload, if present. */
function readStepFinishedUsage(
  data: unknown
): { inputTokens: number; outputTokens: number } | undefined {
  if (typeof data !== 'object' || data === null) {
    return;
  }
  const event = data as { kind?: unknown; metadata?: Record<string, unknown> };
  if (event.kind !== 'run.step.finished') {
    return;
  }
  const inputTokens = event.metadata?.['promptTokens'];
  const outputTokens = event.metadata?.['completionTokens'];
  if (
    typeof inputTokens !== 'number' ||
    typeof outputTokens !== 'number' ||
    !(Number.isFinite(inputTokens) && Number.isFinite(outputTokens)) ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return;
  }
  return { inputTokens, outputTokens };
}

function readFinishUsage(chunk: AssistantStreamChunk): AssistantUsage | undefined {
  if (chunk.type !== 'message-finish') {
    return;
  }
  const billedCostUsd = 'billedCostUsd' in chunk ? chunk.billedCostUsd : undefined;
  if (
    billedCostUsd !== undefined &&
    (typeof billedCostUsd !== 'number' || !Number.isFinite(billedCostUsd) || billedCostUsd < 0)
  ) {
    throw new Error('Provider billed cost must be a finite, non-negative number.');
  }
  const inputTokens =
    chunk.usage && typeof chunk.usage.inputTokens === 'number' ? chunk.usage.inputTokens : 0;
  const outputTokens =
    chunk.usage && typeof chunk.usage.outputTokens === 'number' ? chunk.usage.outputTokens : 0;
  const usageRecord = chunk.usage as Record<string, unknown> | undefined;
  const cacheReadInputTokens = readPositiveCount(usageRecord?.['cacheReadInputTokens']);
  const cacheCreationInputTokens = readPositiveCount(usageRecord?.['cacheCreationInputTokens']);
  const contextInputTokens = readOptionalNonNegativeCount(
    usageRecord?.['contextInputTokens'],
    'contextInputTokens'
  );
  const contextOutputTokens = readOptionalNonNegativeCount(
    usageRecord?.['contextOutputTokens'],
    'contextOutputTokens'
  );
  // Approval-pause finishes contain only zero tokens; do not persist them.
  if (inputTokens + outputTokens === 0 && billedCostUsd === undefined) {
    return;
  }
  return {
    ...(billedCostUsd === undefined ? {} : { billedCostUsd }),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(contextInputTokens === undefined ? {} : { contextInputTokens }),
    ...(contextOutputTokens === undefined ? {} : { contextOutputTokens }),
    inputTokens,
    outputTokens,
  };
}

function readOptionalNonNegativeCount(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a finite, non-negative number.`);
  }
  return value;
}

function readPositiveCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return;
}

function throwIfRunAbortedBeforeTerminalCompletion(
  abortSignal: AbortSignal,
  terminalFinishFlushed: boolean
): void {
  if (!abortSignal.aborted || terminalFinishFlushed) {
    return;
  }
  throw abortSignal.reason ?? new DOMException('Assistant request was aborted.', 'AbortError');
}

/**
 * assistant-stream's decoder emits `message-finish` before it flushes the
 * active implicit text/reasoning part. The accumulator therefore exposes a
 * completed message while inner part streams are still draining. If the user
 * immediately sends the next turn, assistant-ui aborts that visually complete
 * run and a late append can target an already-closed text controller.
 *
 * Buffer the one terminal message marker until decoder EOF so every part-finish
 * reaches the accumulator before the UI observes completion.
 */
function deferMessageFinishUntilFlush(
  onTerminalFinishFlushed?: () => void
): TransformStream<AssistantStreamChunk, AssistantStreamChunk> {
  let pendingFinish: AssistantStreamChunk | undefined;
  return new TransformStream<AssistantStreamChunk, AssistantStreamChunk>({
    flush(controller) {
      if (pendingFinish) {
        controller.enqueue(pendingFinish);
        onTerminalFinishFlushed?.();
      }
    },
    transform(chunk, controller) {
      if (chunk.type === 'message-finish') {
        if (pendingFinish) {
          throw new Error('Assistant data stream emitted more than one message-finish chunk.');
        }
        pendingFinish = chunk;
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

/**
 * Decode the response body and insert the optional pass-through taps (provider
 * usage, run-start context breakdown). Each tap is only piped when its consumer
 * is wired — the common no-consumer path keeps the original decoder →
 * tool-result pipeline untouched.
 */
function buildDecodedTapPipeline(
  body: ReadableStream<Uint8Array>,
  options: Pick<
    BrainstrikeDataStreamRuntimeOptions,
    'onChildRunUsage' | 'onContextBreakdown' | 'onStepUsage' | 'onUsage'
  >,
  onTerminalFinishFlushed?: () => void
): ReadableStream<AssistantStreamChunk> {
  const decoded = body
    .pipeThrough(new DataStreamDecoder())
    .pipeThrough(
      onTerminalFinishFlushed
        ? deferMessageFinishUntilFlush(onTerminalFinishFlushed)
        : deferMessageFinishUntilFlush()
    );
  const usageTapped = options.onUsage
    ? decoded.pipeThrough(buildUsageTap(options.onUsage))
    : decoded;
  const breakdownTapped = options.onContextBreakdown
    ? usageTapped.pipeThrough(buildContextBreakdownTap(options.onContextBreakdown))
    : usageTapped;
  return options.onChildRunUsage || options.onStepUsage
    ? breakdownTapped.pipeThrough(buildThreadUsageEventsTap(options))
    : breakdownTapped;
}

export class BrainstrikeDataStreamRuntimeAdapter implements ChatModelAdapter {
  constructor(private readonly optionsSource: BrainstrikeDataStreamRuntimeOptionsSource) {}

  private get options(): BrainstrikeDataStreamRuntimeOptions {
    return typeof this.optionsSource === 'function' ? this.optionsSource() : this.optionsSource;
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error as Error);
    } catch (callbackError) {
      // Preserve the transport/model error as the runtime failure cause.
      logger.warn('Assistant runtime onError callback failed', { error: callbackError });
    }
  }

  private notifyActivity(): void {
    try {
      this.options.onActivity?.();
    } catch (callbackError) {
      // A liveness hook failure must never break the assistant stream.
      logger.warn('Assistant runtime onActivity callback failed', { error: callbackError });
    }
  }

  /**
   * The insulated pipeline drains to a natural EOF after cancellation/abort
   * (see stream-insulation.ts), so the usage/context-breakdown taps can now
   * observe post-abort chunks. Gate them: an aborted run must not report late
   * usage or breakdown data, matching the pre-insulation lifecycle.
   */
  private abortGatedTapOptions(
    abortSignal: AbortSignal
  ): Pick<
    BrainstrikeDataStreamRuntimeOptions,
    'onChildRunUsage' | 'onContextBreakdown' | 'onStepUsage' | 'onUsage'
  > {
    const { onChildRunUsage, onContextBreakdown, onStepUsage, onUsage } = this.options;
    return {
      ...(onChildRunUsage
        ? {
            onChildRunUsage: (data: unknown) => {
              if (!abortSignal.aborted) {
                onChildRunUsage(data);
              }
            },
          }
        : {}),
      ...(onContextBreakdown
        ? {
            onContextBreakdown: (data: unknown) => {
              if (!abortSignal.aborted) {
                onContextBreakdown(data);
              }
            },
          }
        : {}),
      ...(onStepUsage
        ? {
            onStepUsage: (step: { inputTokens: number; outputTokens: number }) => {
              if (!abortSignal.aborted) {
                onStepUsage(step);
              }
            },
          }
        : {}),
      ...(onUsage
        ? {
            onUsage: (usage: AssistantUsage) => {
              if (!abortSignal.aborted) {
                onUsage(usage);
              }
            },
          }
        : {}),
    };
  }

  private async *consumeResponse(
    response: Response,
    {
      abortSignal,
      context,
      unstable_getMessage,
    }: Pick<ChatModelRunOptions, 'abortSignal' | 'context' | 'unstable_getMessage'>,
    notifyResponse: boolean
  ) {
    let terminalFinishFlushed = false;
    if (!response.ok) {
      throw new Error(
        `Status ${response.status}: ${await readBoundedHttpErrorResponseText(response)}`
      );
    }
    if (!response.body) {
      throw new Error('Response body is null');
    }
    if (notifyResponse) {
      await this.options.onResponse?.(response);
    }

    const stream = insulateAssistantStreamPipeline({
      abortSignal,
      body: response.body,
      buildPipeline: (source) =>
        buildDecodedTapPipeline(source, this.abortGatedTapOptions(abortSignal), () => {
          terminalFinishFlushed = true;
        })
          .pipeThrough(
            unstable_toolResultStream(context.tools ?? {}, abortSignal, () => {
              throw new Error('Tool interrupt is not supported in data stream runtime');
            })
          )
          .pipeThrough(new AssistantMessageAccumulator()),
    });

    try {
      for await (const accumulatedMessage of asAsyncIterableStream(stream)) {
        this.notifyActivity();
        yield accumulatedMessage;
      }
    } finally {
      await stream.cancel(abortSignal.reason).catch(() => undefined);
    }
    throwIfRunAbortedBeforeTerminalCompletion(abortSignal, terminalFinishFlushed);
    this.options.onFinish?.(unstable_getMessage());
  }

  private registerCancelHandler(abortSignal: AbortSignal): void {
    abortSignal.addEventListener(
      'abort',
      () => {
        if (!(abortSignal.reason as { detach?: unknown } | undefined)?.detach) {
          this.options.onCancel?.();
        }
      },
      { once: true }
    );
  }

  async *resume(
    runOptions: ChatModelRunOptions,
    {
      eventId,
      resumeApi,
    }: {
      readonly eventId: string;
      readonly resumeApi: string;
    }
  ) {
    const { abortSignal } = runOptions;
    this.registerCancelHandler(abortSignal);
    try {
      const requestPreparationTimeoutMs =
        this.options.requestPreparationTimeoutMs === undefined
          ? DEFAULT_ASSISTANT_REQUEST_PREPARATION_TIMEOUT_MS
          : this.options.requestPreparationTimeoutMs;
      const { headersValue } = await prepareRequestInputs(
        this.options.headers === undefined ? {} : { headers: this.options.headers },
        abortSignal,
        requestPreparationTimeoutMs
      );
      const headers = new Headers(headersValue);
      headers.set('Last-Event-ID', eventId);
      const response = await fetch(resumeApi, {
        credentials: this.options.credentials ?? 'same-origin',
        headers,
        method: 'GET',
        signal: abortSignal,
      });
      if (response.status === 404) {
        throw new AssistantStreamReplayUnavailableError(
          `Status 404: ${await readBoundedHttpErrorResponseText(response)}`
        );
      }
      yield* this.consumeResponse(response, runOptions, false);
    } catch (error: unknown) {
      const replayError = error instanceof Error ? error : new Error(String(error));
      this.options.onReplayError?.(replayError);
      this.reportError(error);
      throw error;
    }
  }

  async *run({
    messages,
    runConfig,
    abortSignal,
    context,
    unstable_assistantMessageId,
    unstable_getMessage,
  }: ChatModelRunOptions) {
    this.registerCancelHandler(abortSignal);

    try {
      const requestPreparationTimeoutMs =
        this.options.requestPreparationTimeoutMs === undefined
          ? DEFAULT_ASSISTANT_REQUEST_PREPARATION_TIMEOUT_MS
          : this.options.requestPreparationTimeoutMs;
      requireRequestPreparationTimeoutMs(requestPreparationTimeoutMs);
      if (this.options.prepareRequestWarmup) {
        await runAbortableRequestWarmup(this.options.prepareRequestWarmup, abortSignal);
      }
      const { headersValue, rawBodyValue } = await prepareRequestInputs(
        this.options,
        abortSignal,
        requestPreparationTimeoutMs,
        { turnAnchorMessageId: resolveTurnAnchorMessageId(messages) }
      );
      const bodyValue = rawBodyValue as Record<string, unknown> | undefined;
      assertSupportedAssistantUiRequestContext(
        context,
        unstable_getMessage().metadata.unstable_state
      );
      const outboundMessages = resolveOutboundTransportMessages(messages, runConfig);
      const transportMessages = selectTransportMessagesForMastraMemory(outboundMessages, bodyValue);
      const compactedBodyValue = withTransportCompactionMetadata(
        bodyValue,
        outboundMessages.length,
        transportMessages.length
      );
      const imageBound = boundWireMessagesForTransport(
        toLanguageModelMessages(transportMessages),
        compactedBodyValue
      );
      const bodyData = extractTransportBodyData(imageBound.bodyValue);
      const headers = new Headers(headersValue);
      headers.set('Content-Type', 'application/json');

      const requestBody = createAssistantRequestEnvelope({
        ...(unstable_assistantMessageId ? { assistantMessageId: unstable_assistantMessageId } : {}),
        ...(Object.hasOwn(bodyData, 'data') ? { data: bodyData['data'] } : {}),
        messages: imageBound.messages,
        ...(runConfig === undefined ? {} : { runConfig }),
      });
      const serializedRequestBody = JSON.stringify(requestBody);
      const requestBodyLimitBytes = this.options.requestBodyLimitBytes;
      if (requestBodyLimitBytes !== undefined) {
        assertSerializedRequestBodyWithinLimit(serializedRequestBody, requestBodyLimitBytes);
      }

      const response = await fetch(this.options.api, {
        body: serializedRequestBody,
        credentials: this.options.credentials ?? 'same-origin',
        headers,
        method: 'POST',
        signal: abortSignal,
      });

      yield* this.consumeResponse(
        response,
        {
          abortSignal,
          context,
          // biome-ignore lint/style/useNamingConvention: assistant-ui runtime field.
          unstable_getMessage,
        },
        true
      );
    } catch (error: unknown) {
      throwIfRunAbortedBeforeTerminalCompletion(abortSignal, false);
      this.reportError(error);
      throw error;
    }
  }
}

function createRuntimeRequestOptionsSnapshot(input: {
  readonly api: string;
  readonly body: BrainstrikeDataStreamRuntimeOptions['body'];
  readonly credentials: BrainstrikeDataStreamRuntimeOptions['credentials'];
  readonly headers: BrainstrikeDataStreamRuntimeOptions['headers'];
  readonly onActivity: BrainstrikeDataStreamRuntimeOptions['onActivity'];
  readonly onCancel: BrainstrikeDataStreamRuntimeOptions['onCancel'];
  readonly onContextBreakdown: BrainstrikeDataStreamRuntimeOptions['onContextBreakdown'];
  readonly onError: BrainstrikeDataStreamRuntimeOptions['onError'];
  readonly onFinish: BrainstrikeDataStreamRuntimeOptions['onFinish'];
  readonly onReplayError: BrainstrikeDataStreamRuntimeOptions['onReplayError'];
  readonly onResponse: BrainstrikeDataStreamRuntimeOptions['onResponse'];
  readonly prepareRequestWarmup: BrainstrikeDataStreamRuntimeOptions['prepareRequestWarmup'];
  readonly requestBodyLimitBytes: BrainstrikeDataStreamRuntimeOptions['requestBodyLimitBytes'];
  readonly requestPreparationTimeoutMs: BrainstrikeDataStreamRuntimeOptions['requestPreparationTimeoutMs'];
  readonly onUsage: BrainstrikeDataStreamRuntimeOptions['onUsage'];
}): BrainstrikeDataStreamRuntimeOptions {
  return {
    api: input.api,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.onActivity === undefined ? {} : { onActivity: input.onActivity }),
    ...(input.onCancel === undefined ? {} : { onCancel: input.onCancel }),
    ...(input.onContextBreakdown === undefined
      ? {}
      : { onContextBreakdown: input.onContextBreakdown }),
    ...(input.onError === undefined ? {} : { onError: input.onError }),
    ...(input.onFinish === undefined ? {} : { onFinish: input.onFinish }),
    ...(input.onReplayError === undefined ? {} : { onReplayError: input.onReplayError }),
    ...(input.onResponse === undefined ? {} : { onResponse: input.onResponse }),
    ...(input.prepareRequestWarmup === undefined
      ? {}
      : { prepareRequestWarmup: input.prepareRequestWarmup }),
    ...(input.requestBodyLimitBytes === undefined
      ? {}
      : { requestBodyLimitBytes: input.requestBodyLimitBytes }),
    ...(input.requestPreparationTimeoutMs === undefined
      ? {}
      : { requestPreparationTimeoutMs: input.requestPreparationTimeoutMs }),
    ...(input.onUsage === undefined ? {} : { onUsage: input.onUsage }),
  };
}

export function useBrainstrikeDataStreamRuntime(options: BrainstrikeDataStreamRuntimeOptions) {
  const {
    activeRunSession,
    adapters,
    api,
    body,
    credentials,
    headers,
    maxSteps,
    onActivity,
    onCancel,
    onContextBreakdown,
    onError,
    onFinish,
    onReplayError,
    onResponse,
    prepareRequestWarmup,
    replayRetryToken = 0,
    requestBodyLimitBytes,
    requestPreparationTimeoutMs,
    resumeApi,
    onUsage,
    unstable_humanToolNames,
  } = options;
  const requestOptions = createRuntimeRequestOptionsSnapshot({
    api,
    body,
    credentials,
    headers,
    onActivity,
    onCancel,
    onContextBreakdown,
    onError,
    onFinish,
    onReplayError,
    onResponse,
    onUsage,
    prepareRequestWarmup,
    requestBodyLimitBytes,
    requestPreparationTimeoutMs,
  });
  const optionsRef = useRef<BrainstrikeDataStreamRuntimeOptions>(requestOptions);
  // Latest-ref sync in an unconditional layout effect, not during render —
  // React Doctor `no-ref-current-in-render`. Layout, not passive: descendant
  // passive effects (for example FollowUpQueueBridge's queued-send dispatch)
  // can start a run in the same commit that changed these options.
  useLayoutEffect(() => {
    optionsRef.current = requestOptions;
  });
  // Keep the runtime adapter identity stable across renders; it reads the
  // latest callbacks and request options through optionsRef at request time.
  const chatModelAdapter = useMemo(
    () => new BrainstrikeDataStreamRuntimeAdapter(() => optionsRef.current),
    []
  );
  const [replayIdentity] = useState<AssistantReplayMessageIdentityRef>(() => ({
    current: null,
  }));
  const replayAwareAdapters = useMemo(() => {
    const history = adapters?.history;
    if (!history) {
      return adapters;
    }
    return {
      ...adapters,
      history: {
        ...history,
        append: async (item) => {
          const identity = replayIdentity.current;
          await history.append(remapAssistantReplayHistoryItem(item, identity));
        },
      },
    };
  }, [adapters, replayIdentity]);

  const runtime = useLocalRuntime(chatModelAdapter, {
    ...(replayAwareAdapters ? { adapters: replayAwareAdapters } : {}),
    ...(maxSteps ? { maxSteps } : {}),
    // biome-ignore lint/style/useNamingConvention: assistant-ui LocalRuntimeOptions field.
    ...(unstable_humanToolNames ? { unstable_humanToolNames } : {}),
  });
  const replayStream = useCallback<NonNullable<CreateResumeRunConfig['stream']>>(
    (runOptions) => {
      if (!(activeRunSession && resumeApi)) {
        throw new Error('Assistant run replay requires an active session and resume endpoint.');
      }
      return chatModelAdapter.resume(runOptions, {
        eventId: activeRunSession.eventId,
        resumeApi,
      });
    },
    [activeRunSession, chatModelAdapter, resumeApi]
  );
  useAssistantRunReattachment({
    identityRef: replayIdentity,
    record: activeRunSession,
    replayRetryToken,
    runtime,
    stream: replayStream,
  });
  return runtime;
}
