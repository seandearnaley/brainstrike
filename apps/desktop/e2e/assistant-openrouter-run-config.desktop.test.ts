import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const PROMPT_TEXT = 'Summarize this workspace';
const ANSWER = 'Hello from desktop assistant!';
const API_KEY = 'test-key-openrouter-run-config';
const MODEL = 'moonshotai/kimi-k3';

// A new thread runs on the agent host, which calls the provider itself: the
// run's generation settings are read where the provider receives them.
test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function openAssistantChat(window: Page): Promise<void> {
  const assistantChatCard = await ensureAssistantShellVisible(window);
  await expect(assistantChatCard).toBeVisible({ timeout: E2E_TIMEOUTS.cardVisibility });

  const loadingIndicator = window.getByText(/Loading assistant/i);
  if (await loadingIndicator.isVisible().catch(() => false)) {
    await loadingIndicator
      .waitFor({ state: 'hidden', timeout: E2E_TIMEOUTS.loadingIndicator })
      .catch(() => {
        console.warn('⚠️ Assistant UI chunk still loading after timeout');
      });
  }

  const chatPanel = window.getByRole('region', { exact: true, name: 'Assistant' });
  await expect(chatPanel).toBeVisible({ timeout: E2E_TIMEOUTS.chatPanel });
}

async function sendPrompt(window: Page, prompt: string): Promise<void> {
  const input = window.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill(prompt);

  const sendBtn = window.getByRole('button', { exact: true, name: 'Send' });
  await expect(sendBtn).toBeVisible();
  await sendBtn.click();

  await expect(window.getByText(prompt).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
}

/** Select Kimi K3 and enable its catalog row, which host admission reads. */
async function selectKimi(window: Page): Promise<void> {
  await configureAssistantProvider(window, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await enableAssistantCatalogModel(window, `openrouter::${MODEL}`);
}

interface ProviderRequestBody {
  readonly max_tokens?: number;
  readonly reasoning?: { readonly effort?: string };
  readonly stream?: boolean;
}

test.describe('Assistant OpenRouter run config (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    await ensureMockWorkspaceOpen(window);
  });

  test('Kimi K3 sends the reasoning-aware output window (BST-1170)', async ({
    modelProvider,
    window,
  }) => {
    // Kimi K3 reasons by default (catalog Auto effort `low`), and reasoning
    // tokens stream into the output window on OpenRouter — the run must carry
    // Moonshot's documented 131,072 completion window, not the 32,000 coding
    // ceiling that starved thinking+answer and died at `finishReason: length`.
    await selectKimi(window);
    modelProvider.setScript({ finalText: ANSWER });
    await openAssistantChat(window);
    await sendPrompt(window, PROMPT_TEXT);

    await expect(window.getByText(ANSWER).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });

    // The run's own provider call, as OpenRouter receives it.
    const runs = modelProvider
      .requests()
      .filter(({ requestBody }) => (requestBody as ProviderRequestBody).stream === true);
    expect(runs.length).toBeGreaterThan(0);
    const lastRequest = runs.at(-1)?.requestBody as ProviderRequestBody | undefined;
    expect(lastRequest?.max_tokens).toBe(131_072);
    expect(lastRequest?.reasoning).toMatchObject({ effort: 'low' });
  });
});
