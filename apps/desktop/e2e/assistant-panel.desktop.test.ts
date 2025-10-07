import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';

test.describe('Assistant panel (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    await setupAssistantMock(window, { variant: 'simple' });
  });

  test('send message and see streamed response in right panel', async ({ window }) => {
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
    await input.fill('hello desktop');

    const sendBtn = window.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    await expect(window.getByText('hello desktop').first()).toBeVisible({ timeout: 10000 });
    await expect(window.getByText('Hello from desktop assistant!').first()).toBeVisible({
      timeout: 15000,
    });
  });
});
