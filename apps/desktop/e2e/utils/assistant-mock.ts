import type { Page } from '@playwright/test';
import { waitForAppReady } from './electron-helpers';

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-5.2',
  anthropic: 'claude-sonnet-4-5',
  google: 'gemini-3-flash-preview',
  openrouter: 'openai/gpt-5.2',
} as const;

export interface AssistantMockOptions {
  readonly apiKey?: string;
  readonly errorMessage?: string;
  readonly message?: string;
  readonly models?: Record<string, string>;
  readonly provider?: string;
  readonly variant?: 'simple' | 'detailed' | 'tool' | 'tool-error' | 'stream-error';
}

const defaultOptions: Required<AssistantMockOptions> = {
  provider: 'openai',
  apiKey: 'test-api-key-for-e2e-tests',
  message: 'Hello from desktop assistant!',
  errorMessage: 'Assistant request failed.',
  variant: 'simple',
  models: DEFAULT_MODELS,
};

export async function setupAssistantMock(
  page: Page,
  options?: AssistantMockOptions
): Promise<void> {
  const merged = { ...defaultOptions, ...options };

  await page.evaluate(
    async ({ provider, apiKey }) => {
      const globals = globalThis as unknown as {
        secrets?: { saveKey?: (p: string, key: string) => Promise<unknown> };
      };
      await globals.secrets?.saveKey?.(provider, apiKey);
    },
    { provider: merged.provider, apiKey: merged.apiKey }
  );

  await page.addInitScript(
    ({ models, message, variant, errorMessage }) => {
      const globals = globalThis as unknown as Window & {
        fetch: typeof fetch;
        localStorage?: Storage;
        __assistantAvailabilityOverride?: { state: 'enabled' };
      };

      try {
        globals.localStorage?.setItem(
          'assistant-preferences.v1',
          JSON.stringify({
            state: {
              selectedProvider: 'openai',
              modelsByProvider: models,
            },
            version: 1,
          })
        );
      } catch {
        // ignore storage errors in constrained environments
      }

      const originalFetch: typeof globals.fetch = globals.fetch.bind(globals);
      const encoder = new TextEncoder();

      globals.__assistantAvailabilityOverride = { state: 'enabled' };

      const resolveUrl = (input: RequestInfo | URL): string => {
        if (typeof input === 'string') {
          return input;
        }
        if (input instanceof Request) {
          return input.url;
        }
        return String(input);
      };

      const resolvePathname = (url: string): string => {
        try {
          return new URL(url, globals.location?.origin ?? 'http://127.0.0.1').pathname;
        } catch {
          return url;
        }
      };

      const resolveMethod = (input: RequestInfo | URL, init?: RequestInit): string => {
        const requestMethod = input instanceof Request ? input.method : undefined;
        return (init?.method ?? requestMethod ?? 'GET').toUpperCase();
      };

      const isStatusEndpoint = (input: RequestInfo | URL, init?: RequestInit): boolean => {
        const pathname = resolvePathname(resolveUrl(input));
        const method = resolveMethod(input, init);
        return method === 'GET' && (pathname === '/assistant/status' || pathname === '/status');
      };

      const isAssistantStream = (input: RequestInfo | URL, init?: RequestInit): boolean => {
        const pathname = resolvePathname(resolveUrl(input));
        const method = resolveMethod(input, init);
        return (
          method === 'POST' &&
          (pathname === '/assistant' || pathname === '/api/assistant' || pathname === '/')
        );
      };

      const handleStatusResponse = (): Response =>
        new Response(JSON.stringify({ enabled: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });

      const enqueueRaw = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        payload: string
      ): void => {
        controller.enqueue(encoder.encode(payload));
      };

      const enqueueSseEvent = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        payload: object
      ): void => {
        enqueueRaw(controller, `data: ${JSON.stringify(payload)}\n\n`);
      };

      const enqueueDone = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
        enqueueRaw(controller, 'data: [DONE]\n\n');
      };

      const createMessageId = (): string => `msg-${Date.now()}`;
      const createToolCallId = (): string => `tool-${Date.now()}`;

      const writeAssistantText = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        text: string
      ): void => {
        const textId = `text-${Date.now()}`;
        enqueueSseEvent(controller, { type: 'text-start', id: textId });
        enqueueSseEvent(controller, { type: 'text-delta', id: textId, textDelta: text });
        enqueueSseEvent(controller, { type: 'text-end', id: textId });
      };

      const writeFinish = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        finishReason: 'stop' | 'error',
        usage: { completionTokens: number; promptTokens: number }
      ): void => {
        enqueueSseEvent(controller, {
          type: 'finish-step',
          finishReason,
          usage,
          isContinued: false,
        });
        enqueueSseEvent(controller, { type: 'finish', finishReason, usage });
      };

      const writeStreamError = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        errorText: string
      ): void => {
        enqueueSseEvent(controller, { type: 'start', messageId: createMessageId() });
        writeAssistantText(controller, errorText);
        enqueueSseEvent(controller, { type: 'error', errorText });
        writeFinish(controller, 'error', {
          promptTokens: 0,
          completionTokens: 0,
        });
      };

      const writeDetailedStream = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        responseMessage: string
      ): void => {
        enqueueSseEvent(controller, { type: 'start', messageId: createMessageId() });
        writeAssistantText(controller, responseMessage);
        writeFinish(controller, 'stop', {
          promptTokens: 5,
          completionTokens: 8,
        });
      };

      const writeToolSuccessStream = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        responseMessage: string
      ): void => {
        const toolCallId = createToolCallId();
        const toolName = 'brainstrike.retrieveContext';
        const toolArgs = { query: 'mock retrieval query', limit: 3 };
        const toolResult = {
          context: 'File: src/app.ts\nconst answer = 42;',
          chunks: [
            {
              id: 'chunk-1',
              filePath: 'src/app.ts',
              chunkIndex: 0,
              tokenCount: 5,
            },
          ],
        };

        enqueueSseEvent(controller, { type: 'start', messageId: createMessageId() });
        enqueueSseEvent(controller, { type: 'tool-call-start', toolCallId, toolName });
        enqueueSseEvent(controller, {
          type: 'tool-call-delta',
          toolCallId,
          argsText: JSON.stringify(toolArgs),
        });
        enqueueSseEvent(controller, { type: 'tool-call-end', toolCallId });
        enqueueSseEvent(controller, { type: 'tool-result', toolCallId, result: toolResult });
        writeAssistantText(controller, responseMessage);
        writeFinish(controller, 'stop', {
          promptTokens: 5,
          completionTokens: 8,
        });
      };

      const writeToolErrorStream = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        errorText: string
      ): void => {
        const toolCallId = createToolCallId();
        const toolName = 'brainstrike.retrieveContext';
        const toolArgs = { query: 'mock retrieval query', limit: 3 };

        enqueueSseEvent(controller, { type: 'start', messageId: createMessageId() });
        enqueueSseEvent(controller, { type: 'tool-call-start', toolCallId, toolName });
        enqueueSseEvent(controller, {
          type: 'tool-call-delta',
          toolCallId,
          argsText: JSON.stringify(toolArgs),
        });
        enqueueSseEvent(controller, { type: 'tool-call-end', toolCallId });
        enqueueSseEvent(controller, {
          type: 'tool-result',
          toolCallId,
          result: errorText,
          isError: true,
        });
        writeAssistantText(controller, errorText);
        enqueueSseEvent(controller, { type: 'error', errorText });
        writeFinish(controller, 'error', {
          promptTokens: 5,
          completionTokens: 0,
        });
      };

      const writeSimpleStream = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        responseMessage: string
      ): void => {
        enqueueSseEvent(controller, { type: 'start', messageId: createMessageId() });
        writeAssistantText(controller, responseMessage);
        writeFinish(controller, 'stop', {
          promptTokens: 10,
          completionTokens: 5,
        });
      };

      const createStreamResponse = (): Response => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const errorText = errorMessage ?? 'Assistant request failed.';
            const handlers: Record<string, () => void> = {
              'stream-error': () => writeStreamError(controller, errorText),
              detailed: () => writeDetailedStream(controller, message),
              tool: () => writeToolSuccessStream(controller, message),
              'tool-error': () => writeToolErrorStream(controller, errorText),
              simple: () => writeSimpleStream(controller, message),
            };

            const defaultHandler = handlers['simple'];
            if (!defaultHandler) {
              throw new Error('Missing simple stream handler.');
            }

            const handler = handlers[variant ?? 'simple'] ?? defaultHandler;
            handler();
            enqueueDone(controller);
            controller.close();
          },
        });

        const responseHeaders = new Headers({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          'x-vercel-ai-ui-message-stream': 'v1',
        });
        responseHeaders.set('Connection', 'keep-alive');

        return new Response(stream, {
          status: 200,
          headers: responseHeaders,
        });
      };

      const overrideFetch: typeof globals.fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit
      ) => {
        if (isStatusEndpoint(input, init)) {
          return handleStatusResponse();
        }

        if (isAssistantStream(input, init)) {
          return createStreamResponse();
        }

        return originalFetch(input, init);
      };

      globals.fetch = overrideFetch;
    },
    {
      models: merged.models,
      message: merged.message,
      variant: merged.variant,
      errorMessage: merged.errorMessage,
    }
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
}
