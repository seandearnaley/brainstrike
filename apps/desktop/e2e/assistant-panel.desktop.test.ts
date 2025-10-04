import { expect, test } from '@playwright/test';
import type { ElectronAppContext } from './utils/electron-helpers';
import { closeElectronApp, launchElectronApp, waitForAppReady } from './utils/electron-helpers';

test.describe('Assistant panel (desktop)', () => {
  let appContext: ElectronAppContext;

  test.beforeEach(async () => {
    // Launch app
    appContext = await launchElectronApp();
    const page = appContext.window;

    // Mock the assistant API by overriding fetch
    await page.addInitScript(() => {
      const defaultModels = {
        openai: 'gpt-4o-mini',
        anthropic: 'claude-3-5-haiku-latest',
        google: 'gemini-2.5-flash',
        openrouter: 'gpt-4o-mini',
      } as const;

      try {
        window.localStorage?.setItem(
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
        // ignore storage errors in test env
      }

      const secrets = window.secrets ?? {};
      if (!window.secrets) {
        (window as typeof window & { secrets: typeof secrets }).secrets = secrets;
      }
      secrets.list = async () => ['openai'];
      secrets.getKey = async (provider: string) =>
        provider === 'openai' ? 'test-api-key-for-e2e-tests' : null;
      secrets.saveKey = async () => ({ ok: true });
      secrets.deleteKey = async () => {
        return;
      };

      const originalFetch: typeof window.fetch = window.fetch.bind(window);
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
            controller.enqueue(
              encoder.encode(
                '0:["assistant.message",{"content":"Hello from desktop assistant!","role":"assistant"}]\n'
              )
            );
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
          },
        });
      };

      const overrideFetch: typeof window.fetch = async (
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

      window.fetch = overrideFetch;
    });

    // Reload the page to ensure mocks are in place before React components mount
    await page.reload();

    // Wait for app to be ready after reload
    await waitForAppReady(page);

    // Trigger provider refresh now that secrets mock is in place
    // Wait a bit for the store to be initialized and exposed
    await page.waitForTimeout(500);

    await page.evaluate(async () => {
      const store = (
        window as Window & {
          __assistantPreferencesStore?: {
            getState: () => {
              refreshAvailableProviders: () => Promise<unknown>;
              setProvider: (p: string) => void;
            };
          };
        }
      ).__assistantPreferencesStore;
      if (store) {
        const state = store.getState();
        await state.refreshAvailableProviders();
        // Ensure provider is set after refresh
        state.setProvider('openai');
      }
    });
  });

  test.afterEach(async () => {
    if (appContext) await closeElectronApp(appContext);
  });

  test('send message and see streamed response in right panel', async () => {
    const page = appContext.window;

    // Ensure right panel is visible
    const rightPanel = page.locator('[data-panel-id="right-panel"]');
    if (!(await rightPanel.isVisible())) {
      await page.getByRole('button', { name: 'Show right panel' }).click();
      await expect(rightPanel).toBeVisible();
    }

    // Switch to Assistant tab
    const assistantTab = page
      .getByRole('tab')
      .filter({ hasText: /Assistant/i })
      .first();
    await expect(assistantTab).toBeVisible({ timeout: 5000 });
    await assistantTab.click();

    // Wait for the tab content to load
    await page.waitForTimeout(2000);

    // Check for the assistant chat card container first
    const assistantChatCard = page.getByTestId('assistant-chat-card');
    await expect(assistantChatCard).toBeVisible({ timeout: 5000 });

    // Now check for the chat panel specifically (it contains the viewport)
    const chatPanel = page.getByTestId('chat-panel');
    await expect(chatPanel).toBeVisible({ timeout: 15000 });

    // Send a prompt
    const input = page.locator('#assistant-input');
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill('hello desktop');

    const sendBtn = page.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    // Validate user and assistant messages appear
    await expect(page.getByText('You:').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Assistant:').first()).toBeVisible({ timeout: 15000 });
  });
});
