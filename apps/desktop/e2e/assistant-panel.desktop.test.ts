import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureToolsPanelVisible } from './utils/layout-helpers';

test.describe('Assistant panel (desktop)', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ window }) => {
    await setupAssistantMock(window, { variant: 'simple' });
  });

  test('initial assistant mount does not reload the visible renderer', async ({ window }) => {
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    const rightPanel = await ensureToolsPanelVisible(window);
    await expect(rightPanel).toBeVisible();

    const assistantChatCard = window.getByTestId('assistant-chat-card');
    await expect(assistantChatCard).toBeVisible({ timeout: 5000 });

    const loadingIndicator = window.getByText(/Loading assistant/i);
    if (await loadingIndicator.isVisible().catch(() => false)) {
      await loadingIndicator.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {
        throw new Error('Assistant UI chunk did not finish loading on initial mount');
      });
    }

    const chatPanel = window.getByTestId('chat-panel');
    await expect(chatPanel).toBeVisible({ timeout: 25_000 });
    await expect
      .poll(async () => window.evaluate(() => performance.timeOrigin), {
        timeout: 10_000,
        message: 'Initial assistant mount should not reload the visible renderer',
      })
      .toBe(initialTimeOrigin);
  });

  test('send message and see streamed response in tools panel', async ({ window }) => {
    const rightPanel = await ensureToolsPanelVisible(window);
    await expect(rightPanel).toBeVisible();
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

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
    await expect
      .poll(async () => window.evaluate(() => performance.timeOrigin), {
        timeout: 5000,
        message: 'Opening the assistant should not reload the visible renderer',
      })
      .toBe(initialTimeOrigin);

    const input = window.locator('#assistant-input');
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill('hello desktop');

    const sendBtn = window.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    await expect(window.getByText('hello desktop').first()).toBeVisible({ timeout: 10_000 });
    await expect(window.getByText('Hello from desktop assistant!').first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
