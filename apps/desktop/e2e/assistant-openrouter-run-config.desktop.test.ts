import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readAssistantMockRequests, setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const PROMPT_TEXT = 'Summarize this workspace';

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

  const chatPanel = window.getByTestId('chat-panel');
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

interface AssistantRequestBody {
  readonly data?: {
    readonly modelSettings?: { readonly maxOutputTokens?: number };
    readonly providerOptions?: {
      readonly openrouter?: {
        readonly reasoning?: { readonly effort?: string };
      };
    };
  };
}

test.describe('Assistant OpenRouter run config (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await ensureMockWorkspaceOpen(window);
  });

  test('Kimi K3 sends the reasoning-aware output window (BST-1170)', async ({ window }) => {
    // Kimi K3 reasons by default (catalog Auto effort `low`), and reasoning
    // tokens stream into the output window on OpenRouter — the run must carry
    // Moonshot's documented 131,072 completion window, not the 32,000 coding
    // ceiling that starved thinking+answer and died at `finishReason: length`.
    await setupAssistantMock(window, {
      compositeModelKey: 'openrouter::moonshotai/kimi-k3',
      models: { openrouter: 'moonshotai/kimi-k3' },
      provider: 'openrouter',
      variant: 'simple',
    });
    await openAssistantChat(window);
    await sendPrompt(window, PROMPT_TEXT);

    await expect(window.getByText('Hello from desktop assistant!').first()).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });

    const requests = (await readAssistantMockRequests(window)) as AssistantRequestBody[];
    expect(requests.length).toBeGreaterThan(0);
    const lastRequest = requests.at(-1);
    expect(lastRequest?.data?.modelSettings).toMatchObject({ maxOutputTokens: 131_072 });
    expect(lastRequest?.data?.providerOptions?.openrouter?.reasoning).toMatchObject({
      effort: 'low',
    });
  });
});
