import type { Page } from '@playwright/test';
import { waitForAppReady } from './electron-helpers';

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-3-5-haiku-latest',
  google: 'gemini-3-flash-preview',
  openrouter: 'openai/gpt-4o',
} as const;

export interface AssistantMockOptions {
  readonly provider?: string;
  readonly apiKey?: string;
  readonly message?: string;
  readonly errorMessage?: string;
  readonly variant?: 'simple' | 'detailed' | 'tool' | 'tool-error' | 'stream-error';
  readonly models?: Record<string, string>;
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

      const isStatusEndpoint = (url: string): boolean =>
        url.includes('/assistant/status') || url.includes('/status');

      const isAssistantStream = (url: string, init?: RequestInit): boolean =>
        url.includes('/assistant') && init?.method === 'POST';

      const handleStatusResponse = (): Response =>
        new Response(JSON.stringify({ enabled: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const enqueueChunk = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        payload: string
      ): void => {
        controller.enqueue(encoder.encode(payload));
      };

      const writeStreamError = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        errorText: string
      ): void => {
        enqueueChunk(controller, `3:${JSON.stringify(errorText)}\n`);
        enqueueChunk(controller, `0:${JSON.stringify(errorText)}\n`);
        enqueueChunk(
          controller,
          'd:{"finishReason":"error","usage":{"promptTokens":0,"completionTokens":0},"path":[]}\n'
        );
      };

      const writeDetailedStream = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        responseMessage: string
      ): void => {
        const messageId = `msg-${Date.now()}`;
        const sessionId = `sess-${Date.now()}`;

        enqueueChunk(
          controller,
          `2:[{"type":"start","messageId":"${messageId}","sessionId":"${sessionId}"}]\n`
        );
        enqueueChunk(controller, 'f:null\n');
        enqueueChunk(controller, `0:"${responseMessage}"\n`);
        enqueueChunk(controller, 'e:null\n');
        enqueueChunk(
          controller,
          'd:{"finishReason":"stop","usage":{"promptTokens":5,"completionTokens":8}}\n'
        );
      };

      const writeToolSuccessStream = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        responseMessage: string
      ): void => {
        const messageId = `msg-${Date.now()}`;
        const sessionId = `sess-${Date.now()}`;
        const toolCallId = `tool-${Date.now()}`;
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

        enqueueChunk(
          controller,
          `2:[{"type":"start","messageId":"${messageId}","sessionId":"${sessionId}"}]\n`
        );
        enqueueChunk(controller, 'f:null\n');
        enqueueChunk(controller, `b:{"toolCallId":"${toolCallId}","toolName":"${toolName}"}\n`);
        enqueueChunk(
          controller,
          `9:{"toolCallId":"${toolCallId}","toolName":"${toolName}","args":${JSON.stringify(
            toolArgs
          )}}\n`
        );
        enqueueChunk(
          controller,
          `a:{"toolCallId":"${toolCallId}","result":${JSON.stringify(toolResult)}}\n`
        );
        enqueueChunk(controller, `0:"${responseMessage}"\n`);
        enqueueChunk(controller, 'e:null\n');
        enqueueChunk(
          controller,
          'd:{"finishReason":"stop","usage":{"promptTokens":5,"completionTokens":8}}\n'
        );
      };

      const writeToolErrorStream = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        errorText: string
      ): void => {
        const messageId = `msg-${Date.now()}`;
        const sessionId = `sess-${Date.now()}`;
        const toolCallId = `tool-${Date.now()}`;
        const toolName = 'brainstrike.retrieveContext';
        const toolArgs = { query: 'mock retrieval query', limit: 3 };

        enqueueChunk(
          controller,
          `2:[{"type":"start","messageId":"${messageId}","sessionId":"${sessionId}"}]\n`
        );
        enqueueChunk(controller, 'f:null\n');
        enqueueChunk(controller, `b:{"toolCallId":"${toolCallId}","toolName":"${toolName}"}\n`);
        enqueueChunk(
          controller,
          `9:{"toolCallId":"${toolCallId}","toolName":"${toolName}","args":${JSON.stringify(
            toolArgs
          )}}\n`
        );
        enqueueChunk(
          controller,
          `a:{"toolCallId":"${toolCallId}","result":${JSON.stringify(errorText)},"isError":true}\n`
        );
        enqueueChunk(controller, `3:${JSON.stringify(errorText)}\n`);
        enqueueChunk(controller, 'e:null\n');
        enqueueChunk(
          controller,
          'd:{"finishReason":"error","usage":{"promptTokens":5,"completionTokens":0},"path":[]}\n'
        );
      };

      const writeSimpleStream = (
        controller: ReadableStreamDefaultController<Uint8Array>,
        responseMessage: string
      ): void => {
        enqueueChunk(controller, `0:"${responseMessage}"\n`);
        enqueueChunk(
          controller,
          'd:{"finishReason":"stop","usage":{"promptTokens":10,"completionTokens":5}}\n'
        );
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
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'x-vercel-ai-data-stream': 'v1',
            'x-vercel-ai-ui-message-stream': 'v1',
          },
        });
      };

      const overrideFetch: typeof globals.fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit
      ) => {
        const url = resolveUrl(input);

        if (isStatusEndpoint(url)) {
          return handleStatusResponse();
        }

        if (isAssistantStream(url, init)) {
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
