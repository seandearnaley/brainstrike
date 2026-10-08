import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';

test.describe('Assistant chat (desktop)', () => {
  test.skip(!!process.env['CI'], 'Skipped in CI: Electron launch flag incompatibility.');

  test.beforeEach(async ({ modelProvider, window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await configureAssistantProvider(window);
    modelProvider.setScript({ finalText: 'Hello from desktop assistant!' });
    await ensureMockWorkspaceOpen(window);
  });

  test('assistant chat renders messages', async ({ window }) => {
    const assistantChatCard = await ensureAssistantShellVisible(window);
    await expect(assistantChatCard).toBeVisible({ timeout: 5000 });

    const loadingIndicator = window.getByText(/Loading assistant/i);
    if (await loadingIndicator.isVisible().catch(() => false)) {
      await loadingIndicator.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {
        console.warn('⚠️ Assistant UI chunk still loading after timeout');
      });
    }

    const chatPanel = window.getByRole('region', { exact: true, name: 'Assistant' });
    await expect(chatPanel).toBeVisible({ timeout: 25_000 });

    const input = window.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible({ timeout: 5000 });
    await expect(input).toBeEnabled({ timeout: 15_000 });
    await input.fill('list files');

    const sendBtn = window.getByRole('button', { exact: true, name: 'Send' });
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    await expect(window.getByText('list files').first()).toBeVisible({ timeout: 10_000 });
    await expect(window.getByText('Hello from desktop assistant!').first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
