import type { Page } from '@playwright/test';
import { waitForAppReady } from './electron-helpers';

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  google: 'gemini-2.5-flash',
  openrouter: 'gpt-4o-mini',
} as const;

export type AssistantMockOptions = {
  readonly provider?: string;
  readonly apiKey?: string;
  readonly message?: string;
  readonly variant?: 'simple' | 'detailed';
  readonly models?: Record<string, string>;
};

const defaultOptions: Required<AssistantMockOptions> = {
  provider: 'openai',
  apiKey: 'test-api-key-for-e2e-tests',
  message: 'Hello from desktop assistant!',
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
    ({ models, message, variant }) => {
      const globals = globalThis as unknown as Window & {
        fetch: typeof fetch;
        localStorage?: Storage;
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

      const createStreamResponse = (): Response => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (variant === 'detailed') {
              const messageId = `msg-${Date.now()}`;
              const sessionId = `sess-${Date.now()}`;

              controller.enqueue(
                encoder.encode(
                  `2:[{"type":"start","messageId":"${messageId}","sessionId":"${sessionId}"}]\n`
                )
              );
              controller.enqueue(encoder.encode('f:null\n'));
              controller.enqueue(encoder.encode(`0:"${message}"\n`));
              controller.enqueue(encoder.encode('e:null\n'));
              controller.enqueue(
                encoder.encode(
                  'd:{"finishReason":"stop","usage":{"promptTokens":5,"completionTokens":8}}\n'
                )
              );
              controller.close();
              return;
            }

            controller.enqueue(encoder.encode(`0:"${message}"\n`));
            controller.enqueue(
              encoder.encode(
                'd:{"finishReason":"stop","usage":{"promptTokens":10,"completionTokens":5}}\n'
              )
            );
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
    }
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
}
