import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';

test.describe('Assistant panel (desktop)', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await setupAssistantMock(window, { variant: 'simple' });
    await ensureMockWorkspaceOpen(window);
  });

  test('initial assistant mount does not reload the visible renderer', async ({ window }) => {
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    const assistantChatCard = await ensureAssistantShellVisible(window);
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
        message: 'Initial assistant mount should not reload the visible renderer',
        timeout: 10_000,
      })
      .toBe(initialTimeOrigin);
  });

  test('prompts loads in the sidebar while the assistant shell stays available', async ({
    window,
  }) => {
    const assistantChatCard = await ensureAssistantShellVisible(window);
    await expect(assistantChatCard).toBeVisible({ timeout: 5000 });

    const promptsTab = window.getByTestId('prompts-tab-trigger');
    await expect(promptsTab).toBeVisible({ timeout: 10_000 });
    await promptsTab.click();

    await expect(window.getByRole('region', { name: 'Prompt workbench' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(assistantChatCard).toBeVisible();
  });

  test('send message and see streamed response in assistant shell', async ({ window }) => {
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    const assistantChatCard = await ensureAssistantShellVisible(window);
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
        message: 'Opening the assistant should not reload the visible renderer',
        timeout: 5000,
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
