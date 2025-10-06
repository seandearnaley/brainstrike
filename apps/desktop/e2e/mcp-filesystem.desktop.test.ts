import { expect, test } from './fixtures/electron-fixture';

test.describe('Assistant chat (desktop)', () => {
  test.skip(!!process.env.CI, 'Skipped in CI: Electron launch flag incompatibility.');

  test.beforeEach(async ({ window }) => {
    await window.evaluate(async () => {
      const globals = globalThis as unknown as Window & {
        secrets?: { saveKey?: (provider: string, key: string) => Promise<{ ok: boolean } | true> };
      };
      await globals.secrets?.saveKey?.('openai', 'test-api-key-for-e2e-tests');
    });

    await window.addInitScript(() => {
      const globals = globalThis as unknown as Window & {
        localStorage?: Storage;
        fetch: typeof fetch;
      };

      const defaultModels = {
        openai: 'gpt-4o-mini',
        anthropic: 'claude-3-5-haiku-latest',
        google: 'gemini-2.5-flash',
        openrouter: 'gpt-4o-mini',
      } as const;

      try {
        globals.localStorage?.setItem(
          'assistant-preferences.v1',
          JSON.stringify({
            state: {
              selectedProvider: 'openai',
              modelsByProvider: defaultModels,
            },
            version: 1,
          })
        );
      } catch {
        // ignore storage errors during setup
      }

      const originalFetch: typeof globals.fetch = globals.fetch.bind(globals);
      const encoder = new TextEncoder();

      const resolveUrl = (input: RequestInfo | URL): string => {
        if (typeof input === 'string') return input;
        if (input instanceof Request) return input.url;
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
            const messageId = `msg-${Date.now()}`;
            const sessionId = `sess-${Date.now()}`;

            controller.enqueue(
              encoder.encode(
                `2:[{"type":"start","messageId":"${messageId}","sessionId":"${sessionId}"}]\n`
              )
            );
            controller.enqueue(encoder.encode('f:null\n'));
            controller.enqueue(encoder.encode('0:"Hello from desktop assistant!"\n'));
            controller.enqueue(encoder.encode('e:null\n'));
            controller.enqueue(
              encoder.encode(
                'd:{"finishReason":"stop","usage":{"promptTokens":5,"completionTokens":8}}\n'
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
    });

    await window.reload();
  });

  test('assistant chat renders messages', async ({ window }) => {
    const rightPanel = window.locator('[data-panel-id="right-panel"]');
    if (!(await rightPanel.isVisible())) {
      await window.getByRole('button', { name: 'Show right panel' }).click();
      await expect(rightPanel).toBeVisible();
    }

    const assistantTab = window
      .getByRole('tab')
      .filter({ hasText: /Assistant/i })
      .first();
    await expect(assistantTab).toBeVisible({ timeout: 5000 });
    await assistantTab.click();

    await window.waitForTimeout(2000);

    const assistantChatCard = window.getByTestId('assistant-chat-card');
    await expect(assistantChatCard).toBeVisible({ timeout: 5000 });

    const chatPanel = window.getByTestId('chat-panel');
    await expect(chatPanel).toBeVisible({ timeout: 15000 });

    const input = window.locator('#assistant-input');
    await expect(input).toBeVisible({ timeout: 5000 });
    await expect(input).toBeEnabled({ timeout: 15000 });
    await input.fill('list files');

    const sendBtn = window.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    await expect(window.getByText('list files').first()).toBeVisible({ timeout: 10000 });
    await expect(window.getByText('Hello from desktop assistant!').first()).toBeVisible({
      timeout: 15000,
    });
  });
});
