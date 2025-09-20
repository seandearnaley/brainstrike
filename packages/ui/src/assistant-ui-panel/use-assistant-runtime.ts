import {
  type AssistantRuntime,
  type ChatModelAdapter,
  type ChatModelRunOptions,
  type ChatModelRunResult,
  INTERNAL,
  type LocalRuntimeOptions,
  type ThreadMessage,
  type Tool,
  useLocalRuntime,
} from '@assistant-ui/react';
import {
  type UseDataStreamRuntimeOptions as LibraryOptions,
  toLanguageModelMessages,
} from '@assistant-ui/react-data-stream';
import {
  AssistantMessageAccumulator,
  DataStreamDecoder,
  unstable_toolResultStream,
} from 'assistant-stream';
import { asAsyncIterableStream } from 'assistant-stream/utils';
import type { JSONSchema7 } from 'json-schema';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const { splitLocalRuntimeOptions } = INTERNAL;

type HeadersValue = Record<string, string> | Headers;

type AdapterOptions = Omit<LibraryOptions, keyof LocalRuntimeOptions>;

const isZodSchema = (parameters: Tool['parameters']): parameters is ZodTypeAny => {
  return Boolean(parameters) && typeof (parameters as ZodTypeAny).safeParse === 'function';
};

const toJSONSchema7 = (parameters: Tool['parameters']): JSONSchema7 | undefined => {
  if (!parameters) {
    return undefined;
  }

  if (isZodSchema(parameters)) {
    return zodToJsonSchema(parameters, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }) as JSONSchema7;
  }

  return parameters as JSONSchema7;
};

const toAISDKTools = (tools: Record<string, Tool>) => {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const parameters = toJSONSchema7(tool.parameters);

      return [
        name,
        {
          ...(tool.description ? { description: tool.description } : undefined),
          ...(parameters ? { parameters } : undefined),
        },
      ];
    })
  );
};

const getEnabledTools = (tools: Record<string, Tool>) => {
  return Object.fromEntries(
    Object.entries(tools).filter(([, tool]) => !tool.disabled && tool.type !== 'backend')
  );
};

const isAbortError = (error: unknown): boolean => {
  if (!error) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return false;
};

const isDetachingAbort = (signal: AbortSignal): boolean => {
  const reason = signal.reason;
  if (typeof reason !== 'object' || reason === null) return false;
  return Boolean((reason as { detach?: boolean }).detach);
};

const toCancelledStatus = (): NonNullable<ThreadMessage['status']> => ({
  type: 'incomplete',
  reason: 'cancelled',
});

const toCancelledResult = (): ChatModelRunResult => ({
  status: toCancelledStatus(),
});

class BrainstrikeDataStreamRuntimeAdapter implements ChatModelAdapter {
  constructor(private readonly options: AdapterOptions) {}

  async *run({
    messages,
    runConfig,
    abortSignal,
    context,
    unstable_assistantMessageId: unstableAssistantMessageId,
    unstable_getMessage: unstableGetMessage,
  }: ChatModelRunOptions) {
    const headers = await this.prepareHeaders();
    this.setupAbortHandler(abortSignal);

    const requestBody = this.buildRequestBody(
      messages,
      runConfig,
      context,
      unstableAssistantMessageId,
      unstableGetMessage
    );

    const response = await this.makeRequest(headers, requestBody, abortSignal);
    await this.options.onResponse?.(response);

    try {
      await this.validateResponse(response);
      const stream = this.createStream(response.body as ReadableStream, context, abortSignal);
      yield* asAsyncIterableStream(stream);

      if (!abortSignal.aborted) {
        this.options.onFinish?.(unstableGetMessage());
      }
    } catch (error: unknown) {
      yield* this.handleError(error, abortSignal, unstableGetMessage);
    }
  }

  private async prepareHeaders(): Promise<Headers> {
    const headersValue =
      typeof this.options.headers === 'function'
        ? await this.options.headers()
        : this.options.headers;

    const headers = new Headers(headersValue as HeadersValue | undefined);
    headers.set('Content-Type', 'application/json');
    return headers;
  }

  private setupAbortHandler(abortSignal: AbortSignal): void {
    abortSignal.addEventListener(
      'abort',
      () => {
        if (!isDetachingAbort(abortSignal)) {
          this.options.onCancel?.();
        }
      },
      { once: true }
    );
  }

  private buildRequestBody(
    // biome-ignore lint/suspicious/noExplicitAny: Required for library compatibility
    messages: any,
    runConfig: unknown,
    // biome-ignore lint/suspicious/noExplicitAny: Required for library compatibility
    context: any,
    unstableAssistantMessageId: string | undefined,
    unstableGetMessage: () => ThreadMessage
  ): string {
    return JSON.stringify({
      system: context.system,
      messages: toLanguageModelMessages(messages, {
        // biome-ignore lint/style/useNamingConvention: Library expects this property name
        unstable_includeId: this.options.sendExtraMessageFields,
      }),
      tools: toAISDKTools(getEnabledTools(context.tools ?? {})),
      ...(unstableAssistantMessageId ? { unstableAssistantMessageId } : {}),
      runConfig,
      state: unstableGetMessage().metadata.unstable_state || undefined,
      ...context.callSettings,
      ...context.config,
      ...this.options.body,
    });
  }

  private async makeRequest(
    headers: Headers,
    body: string,
    signal: AbortSignal
  ): Promise<Response> {
    return fetch(this.options.api, {
      method: 'POST',
      headers,
      credentials: this.options.credentials ?? 'same-origin',
      body,
      signal,
    });
  }

  private async validateResponse(response: Response): Promise<void> {
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Status ${response.status}: ${errorText}`);
    }
    if (!response.body) {
      throw new Error('Response body is null');
    }
  }

  private createStream(
    body: ReadableStream,
    // biome-ignore lint/suspicious/noExplicitAny: Required for library compatibility
    context: any,
    abortSignal: AbortSignal
  ): ReadableStream {
    return body
      .pipeThrough(new DataStreamDecoder())
      .pipeThrough(unstable_toolResultStream(context.tools, abortSignal))
      .pipeThrough(new AssistantMessageAccumulator());
  }

  private async *handleError(
    error: unknown,
    abortSignal: AbortSignal,
    unstableGetMessage: () => ThreadMessage
  ): AsyncGenerator<ChatModelRunResult> {
    const aborted = abortSignal.aborted || isAbortError(error);
    if (aborted && !isDetachingAbort(abortSignal)) {
      yield* this.handleAbortedError(unstableGetMessage);
      return;
    }

    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  private async *handleAbortedError(
    unstableGetMessage: () => ThreadMessage
  ): AsyncGenerator<ChatModelRunResult> {
    const currentMessage = unstableGetMessage();
    if (currentMessage.role !== 'assistant' || currentMessage.status?.type !== 'running') {
      return;
    }

    yield toCancelledResult();
    // Wait a microtask so downstream consumers process the yield before finishing.
    await Promise.resolve();

    const updatedMessage = unstableGetMessage();
    const status =
      updatedMessage.status?.type === 'running' ? toCancelledStatus() : updatedMessage.status;

    if (status) {
      this.options.onFinish?.({ ...updatedMessage, status });
    } else {
      this.options.onFinish?.(updatedMessage);
    }
  }
}

export type AssistantDataStreamRuntimeOptions = LibraryOptions;

export const useAssistantDataStreamRuntime = (
  options: AssistantDataStreamRuntimeOptions
): AssistantRuntime => {
  const { localRuntimeOptions, otherOptions } = splitLocalRuntimeOptions(options);

  return useLocalRuntime(
    new BrainstrikeDataStreamRuntimeAdapter(otherOptions),
    localRuntimeOptions
  );
};
