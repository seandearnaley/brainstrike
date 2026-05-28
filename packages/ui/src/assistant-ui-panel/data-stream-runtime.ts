import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  LocalRuntimeOptionsBase,
  ThreadMessage,
} from '@assistant-ui/react';
import { useLocalRuntime } from '@assistant-ui/react';
import { createLogger } from '@brainstrike/utils/logger';
import { sliceCodePoints } from '@brainstrike/utils/string-utils';
import {
  AssistantMessageAccumulator,
  DataStreamDecoder,
  toGenericMessages,
  toToolsJSONSchema,
  // This runtime is pinned to assistant-stream 0.3.11 because tool result
  // streaming is still exported behind the unstable API surface.
  unstable_toolResultStream,
} from 'assistant-stream';
import { asAsyncIterableStream } from 'assistant-stream/utils';
import { useMemo, useRef } from 'react';

type HeadersValue = Headers | Record<string, string>;
const logger = createLogger('BrainstrikeDataStreamRuntime');
const MAX_HTTP_ERROR_RESPONSE_TEXT_CHARS = 4000;
const RESERVED_TRANSPORT_FIELDS = new Set([
  'data',
  'messages',
  'parentId',
  'runConfig',
  'state',
  'system',
  'threadId',
  'tools',
  'unstable_assistantMessageId',
]);

export type BrainstrikeDataStreamRuntimeOptions = {
  api: string;
  body?: (() => Promise<Record<string, unknown> | undefined>) | Record<string, unknown>;
  credentials?: RequestCredentials;
  headers?: (() => Promise<HeadersValue>) | HeadersValue;
  onCancel?: () => void;
  onError?: (error: Error) => void;
  onFinish?: (message: ThreadMessage) => void;
  onResponse?: (response: Response) => Promise<void> | void;
} & Omit<LocalRuntimeOptionsBase, 'adapters'> & {
    adapters?: Omit<LocalRuntimeOptionsBase['adapters'], 'chatModel'>;
  };
type BrainstrikeDataStreamRuntimeOptionsSource =
  | BrainstrikeDataStreamRuntimeOptions
  | (() => BrainstrikeDataStreamRuntimeOptions);

interface GenericTextPart {
  readonly text?: unknown;
  readonly type?: unknown;
}

interface GenericMessageLike {
  readonly content?: readonly GenericTextPart[];
  readonly role?: unknown;
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
    type: 'file',
    data: String(record['data'] ?? ''),
    mediaType: optionalStringField(part, 'mediaType'),
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

function assertNoTransportFieldCollisions(
  value: Record<string, unknown> | undefined,
  sourceName: string
): void {
  if (!value) {
    return;
  }
  const collisionKeys = Object.keys(value).filter((key) => RESERVED_TRANSPORT_FIELDS.has(key));
  if (collisionKeys.length === 0) {
    return;
  }
  throw new Error(
    `Assistant runtime ${sourceName} cannot override transport field(s): ${collisionKeys.join(', ')}.`
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
  const genericMessages = toGenericMessages(messages as Parameters<typeof toGenericMessages>[0]);
  return genericMessages.map((message) => {
    const item = message as GenericMessageLike;
    const content = item.content ?? [];
    switch (item.role) {
      case 'system':
        return {
          role: 'system',
          content: content.map((part) => (part.type === 'text' ? toHostedTextPart(part) : part)),
        };
      case 'user':
        return {
          role: 'user',
          content: content.map((part) =>
            part.type === 'text' ? toHostedTextPart(part) : toUserFilePart(part)
          ),
        };
      case 'assistant':
        return {
          role: 'assistant',
          content: content.map((part) =>
            part.type === 'text'
              ? toHostedTextPart(part)
              : {
                  type: 'tool-call',
                  toolCallId: requireStringField(part, 'toolCallId', 'assistant tool-call part'),
                  toolName: requireStringField(part, 'toolName', 'assistant tool-call part'),
                  input: toPartRecord(part)['args'],
                }
          ),
        };
      case 'tool':
        return {
          role: 'tool',
          content: content.map((part) => {
            const record = toPartRecord(part);
            return {
              type: 'tool-result',
              toolCallId: requireStringField(part, 'toolCallId', 'tool result part'),
              toolName: optionalStringField(part, 'toolName'),
              output: record['isError']
                ? { type: 'error-json', value: record['result'] }
                : { type: 'json', value: record['result'] },
            };
          }),
        };
      default:
        return { role: item.role, content };
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

  async *run({
    messages,
    runConfig,
    abortSignal,
    context,
    unstable_assistantMessageId,
    unstable_threadId,
    unstable_parentId,
    unstable_getMessage,
  }: ChatModelRunOptions) {
    abortSignal.addEventListener(
      'abort',
      () => {
        if (!(abortSignal.reason as { detach?: unknown } | undefined)?.detach) {
          this.options.onCancel?.();
        }
      },
      { once: true }
    );

    try {
      const headersValue =
        typeof this.options.headers === 'function'
          ? await this.options.headers()
          : this.options.headers;
      const rawBodyValue =
        typeof this.options.body === 'function' ? await this.options.body() : this.options.body;
      const bodyValue = rawBodyValue as Record<string, unknown> | undefined;
      const transportMessages = selectTransportMessagesForMastraMemory(messages, bodyValue);
      const compactedBodyValue = withTransportCompactionMetadata(
        bodyValue,
        messages.length,
        transportMessages.length
      );
      const bodyData = extractTransportBodyData(compactedBodyValue);
      assertNoTransportFieldCollisions(context.callSettings, 'callSettings');
      assertNoTransportFieldCollisions(context.config, 'config');
      const headers = new Headers(headersValue);
      headers.set('Content-Type', 'application/json');

      const requestBody: Record<string, unknown> = {
        messages: toLanguageModelMessages(transportMessages),
        tools: toToolsJSONSchema(context.tools ?? {}),
        ...(context.system ? { system: context.system } : {}),
        // biome-ignore lint/style/useNamingConvention: assistant-ui transport field.
        ...(unstable_assistantMessageId ? { unstable_assistantMessageId } : {}),
        ...(unstable_threadId ? { threadId: unstable_threadId } : {}),
        ...(unstable_parentId === undefined ? {} : { parentId: unstable_parentId }),
        ...(runConfig === undefined ? {} : { runConfig }),
        ...(unstable_getMessage().metadata.unstable_state
          ? { state: unstable_getMessage().metadata.unstable_state }
          : {}),
        ...context.callSettings,
        ...context.config,
        ...(Object.hasOwn(bodyData, 'data') ? { data: bodyData['data'] } : {}),
      };

      const response = await fetch(this.options.api, {
        method: 'POST',
        headers,
        credentials: this.options.credentials ?? 'same-origin',
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        throw new Error(
          `Status ${response.status}: ${await readBoundedHttpErrorResponseText(response)}`
        );
      }
      if (!response.body) {
        throw new Error('Response body is null');
      }

      await this.options.onResponse?.(response);

      const stream = response.body
        .pipeThrough(new DataStreamDecoder())
        .pipeThrough(
          unstable_toolResultStream(context.tools ?? {}, abortSignal, () => {
            throw new Error('Tool interrupt is not supported in data stream runtime');
          })
        )
        .pipeThrough(new AssistantMessageAccumulator());

      yield* asAsyncIterableStream(stream);
      this.options.onFinish?.(unstable_getMessage());
    } catch (error: unknown) {
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
  readonly onCancel: BrainstrikeDataStreamRuntimeOptions['onCancel'];
  readonly onError: BrainstrikeDataStreamRuntimeOptions['onError'];
  readonly onFinish: BrainstrikeDataStreamRuntimeOptions['onFinish'];
  readonly onResponse: BrainstrikeDataStreamRuntimeOptions['onResponse'];
}): BrainstrikeDataStreamRuntimeOptions {
  return {
    api: input.api,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.onCancel === undefined ? {} : { onCancel: input.onCancel }),
    ...(input.onError === undefined ? {} : { onError: input.onError }),
    ...(input.onFinish === undefined ? {} : { onFinish: input.onFinish }),
    ...(input.onResponse === undefined ? {} : { onResponse: input.onResponse }),
  };
}

export function useBrainstrikeDataStreamRuntime(options: BrainstrikeDataStreamRuntimeOptions) {
  const {
    adapters,
    api,
    body,
    credentials,
    headers,
    maxSteps,
    onCancel,
    onError,
    onFinish,
    onResponse,
    unstable_humanToolNames,
  } = options;
  const requestOptions = createRuntimeRequestOptionsSnapshot({
    api,
    body,
    credentials,
    headers,
    onCancel,
    onError,
    onFinish,
    onResponse,
  });
  const optionsRef = useRef<BrainstrikeDataStreamRuntimeOptions>(requestOptions);
  optionsRef.current = requestOptions;
  // Keep the runtime adapter identity stable across renders; it reads the
  // latest callbacks and request options through optionsRef at request time.
  const chatModelAdapter = useMemo(
    () => new BrainstrikeDataStreamRuntimeAdapter(() => optionsRef.current),
    []
  );

  return useLocalRuntime(chatModelAdapter, {
    ...(adapters ? { adapters } : {}),
    ...(maxSteps ? { maxSteps } : {}),
    // biome-ignore lint/style/useNamingConvention: assistant-ui LocalRuntimeOptions field.
    ...(unstable_humanToolNames ? { unstable_humanToolNames } : {}),
  });
}
