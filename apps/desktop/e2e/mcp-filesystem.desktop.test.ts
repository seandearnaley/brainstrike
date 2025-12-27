import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';

test.describe('Assistant chat (desktop)', () => {
  test.skip(!!process.env['CI'], 'Skipped in CI: Electron launch flag incompatibility.');

  test.beforeEach(async ({ window }) => {
    await setupAssistantMock(window, { variant: 'detailed' });
  });

  test('assistant chat renders messages', async ({ window }) => {
    const rightPanel = window.locator('[data-panel-id="tools-panel"]');
    if (!(await rightPanel.isVisible())) {
      await window.getByRole('button', { name: 'Show tools panel' }).click();
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
    await expect(chatPanel).toBeVisible({ timeout: 15_000 });

    const input = window.locator('#assistant-input');
    await expect(input).toBeVisible({ timeout: 5000 });
    await expect(input).toBeEnabled({ timeout: 15_000 });
    await input.fill('list files');

    const sendBtn = window.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    await expect(window.getByText('list files').first()).toBeVisible({ timeout: 10_000 });
    await expect(window.getByText('Hello from desktop assistant!').first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
