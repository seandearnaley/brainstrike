import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  LocalRuntimeOptionsBase,
  ThreadMessage,
} from '@assistant-ui/react';
import { useLocalRuntime } from '@assistant-ui/react';
import {
  AssistantMessageAccumulator,
  DataStreamDecoder,
  toGenericMessages,
  toToolsJSONSchema,
  unstable_toolResultStream,
} from 'assistant-stream';
import { asAsyncIterableStream } from 'assistant-stream/utils';

type HeadersValue = Headers | Record<string, string>;

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

interface GenericTextPart {
  readonly text?: unknown;
  readonly type?: unknown;
}

interface GenericMessageLike {
  readonly content?: readonly GenericTextPart[];
  readonly role?: unknown;
}

function isMemoryBackedRequest(bodyValue: Record<string, unknown> | undefined): boolean {
  const data = bodyValue?.['data'];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  return Boolean((data as { memory?: unknown }).memory);
}

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
  return messages;
}

function toLanguageModelMessages(messages: readonly ThreadMessage[]): unknown[] {
  const genericMessages = toGenericMessages(messages as Parameters<typeof toGenericMessages>[0]);
  return genericMessages.map((message) => {
    const item = message as GenericMessageLike;
    const content = item.content ?? [];
    switch (item.role) {
      case 'system':
        return { role: 'system', content };
      case 'user':
        return {
          role: 'user',
          content: content.map((part) =>
            part.type === 'text'
              ? part
              : {
                  type: 'file',
                  data: String((part as { data?: unknown }).data ?? ''),
                  mediaType: (part as { mediaType?: unknown }).mediaType,
                }
          ),
        };
      case 'assistant':
        return {
          role: 'assistant',
          content: content.map((part) =>
            part.type === 'text'
              ? part
              : {
                  type: 'tool-call',
                  toolCallId: (part as { toolCallId?: unknown }).toolCallId,
                  toolName: (part as { toolName?: unknown }).toolName,
                  input: (part as { args?: unknown }).args,
                }
          ),
        };
      case 'tool':
        return {
          role: 'tool',
          content: content.map((part) => ({
            type: 'tool-result',
            toolCallId: (part as { toolCallId?: unknown }).toolCallId,
            toolName: (part as { toolName?: unknown }).toolName,
            output: (part as { isError?: unknown; result?: unknown }).isError
              ? { type: 'error-json', value: (part as { result?: unknown }).result }
              : { type: 'json', value: (part as { result?: unknown }).result },
          })),
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

class BrainstrikeDataStreamRuntimeAdapter implements ChatModelAdapter {
  constructor(private readonly options: BrainstrikeDataStreamRuntimeOptions) {}

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

    abortSignal.addEventListener(
      'abort',
      () => {
        if (!(abortSignal.reason as { detach?: unknown } | undefined)?.detach) {
          this.options.onCancel?.();
        }
      },
      { once: true }
    );

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
      ...(compactedBodyValue ?? {}),
    };

    const response = await fetch(this.options.api, {
      method: 'POST',
      headers,
      credentials: this.options.credentials ?? 'same-origin',
      body: JSON.stringify(requestBody),
      signal: abortSignal,
    });

    await this.options.onResponse?.(response);

    try {
      if (!response.ok) {
        throw new Error(`Status ${response.status}: ${await response.text()}`);
      }
      if (!response.body) {
        throw new Error('Response body is null');
      }

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
      this.options.onError?.(error as Error);
      throw error;
    }
  }
}

export function useBrainstrikeDataStreamRuntime(options: BrainstrikeDataStreamRuntimeOptions) {
  const { adapters, maxSteps, unstable_humanToolNames, ...adapterOptions } = options;
  return useLocalRuntime(new BrainstrikeDataStreamRuntimeAdapter(adapterOptions), {
    ...(adapters ? { adapters } : {}),
    ...(maxSteps ? { maxSteps } : {}),
    // biome-ignore lint/style/useNamingConvention: assistant-ui LocalRuntimeOptions field.
    ...(unstable_humanToolNames ? { unstable_humanToolNames } : {}),
  });
}
