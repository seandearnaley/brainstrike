import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureToolsPanelVisible } from './utils/layout-helpers';

test.describe('Assistant retrieval (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    await setupAssistantMock(window, { variant: 'tool', message: 'Retrieved answer.' });
  });

  test('shows retrieval tool event and response', async ({ window }) => {
    const rightPanel = await ensureToolsPanelVisible(window);
    await expect(rightPanel).toBeVisible();

    const assistantTab = window.getByRole('tab', { name: /assistant/i }).first();
    await expect(assistantTab).toBeVisible({ timeout: 5000 });
    await assistantTab.click();

    const assistantChatCard = window.getByTestId('assistant-chat-card');
    await expect(assistantChatCard).toBeVisible({ timeout: 5000 });

    const loadingIndicator = window.getByText(/Loading assistant/i);
    if (await loadingIndicator.isVisible().catch(() => false)) {
      await loadingIndicator.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {
        console.warn('⚠️ Assistant UI chunk still loading after timeout');
      });
    }

    const chatPanel = window.getByTestId('chat-panel');
    await expect(chatPanel).toBeVisible({ timeout: 25_000 });

    const input = window.locator('#assistant-input');
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill('Find relevant context');

    const sendBtn = window.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    await expect(window.getByText('Find relevant context').first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(window.getByTestId('tool-fallback').first()).toBeVisible({ timeout: 15_000 });
    await expect(window.getByText('brainstrike.retrieveContext').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(window.getByText('Retrieved answer.').first()).toBeVisible({ timeout: 15_000 });
  });
});
