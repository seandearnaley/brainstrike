import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureToolsPanelVisible } from './utils/layout-helpers';

const TAB_VISIBILITY_TIMEOUT_MS = 5000;
const CARD_VISIBILITY_TIMEOUT_MS = 5000;
const INPUT_VISIBILITY_TIMEOUT_MS = 5000;
const LOADING_INDICATOR_TIMEOUT_MS = 20_000;
const CHAT_PANEL_TIMEOUT_MS = 25_000;
const MESSAGE_VISIBILITY_TIMEOUT_MS = 10_000;
const TOOL_VISIBILITY_TIMEOUT_MS = 15_000;

test.describe('Assistant retrieval (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    await setupAssistantMock(window, { variant: 'tool', message: 'Retrieved answer.' });
  });

  test('shows retrieval tool event and response', async ({ window }) => {
    const rightPanel = await ensureToolsPanelVisible(window);
    await expect(rightPanel).toBeVisible();

    const assistantTab = window.getByRole('tab', { name: /assistant/i }).first();
    await expect(assistantTab).toBeVisible({ timeout: TAB_VISIBILITY_TIMEOUT_MS });
    await assistantTab.click();

    const assistantChatCard = window.getByTestId('assistant-chat-card');
    await expect(assistantChatCard).toBeVisible({ timeout: CARD_VISIBILITY_TIMEOUT_MS });

    const loadingIndicator = window.getByText(/Loading assistant/i);
    if (await loadingIndicator.isVisible().catch(() => false)) {
      await loadingIndicator
        .waitFor({ state: 'hidden', timeout: LOADING_INDICATOR_TIMEOUT_MS })
        .catch(() => {
          console.warn('⚠️ Assistant UI chunk still loading after timeout');
        });
    }

    const chatPanel = window.getByTestId('chat-panel');
    await expect(chatPanel).toBeVisible({ timeout: CHAT_PANEL_TIMEOUT_MS });

    const input = window.locator('#assistant-input');
    await expect(input).toBeVisible({ timeout: INPUT_VISIBILITY_TIMEOUT_MS });
    await input.fill('Find relevant context');

    const sendBtn = window.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    await expect(window.getByText('Find relevant context').first()).toBeVisible({
      timeout: MESSAGE_VISIBILITY_TIMEOUT_MS,
    });
    await expect(window.getByTestId('tool-fallback').first()).toBeVisible({
      timeout: TOOL_VISIBILITY_TIMEOUT_MS,
    });
    await expect(window.getByText('brainstrike.retrieveContext').first()).toBeVisible({
      timeout: TOOL_VISIBILITY_TIMEOUT_MS,
    });
    await expect(window.getByText('Retrieved answer.').first()).toBeVisible({
      timeout: TOOL_VISIBILITY_TIMEOUT_MS,
    });
  });
});
