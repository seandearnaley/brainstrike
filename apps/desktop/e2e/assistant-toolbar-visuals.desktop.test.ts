import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

test.describe('Assistant hover toolbar (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await ensureMockWorkspaceOpen(window);
  });

  test('shows a bare, smaller copy/retry toolbar on hover', async ({ window }) => {
    await setupAssistantMock(window, {
      message: 'Hello from desktop assistant!',
      variant: 'detailed',
    });

    const assistantChatCard = await ensureAssistantShellVisible(window);
    await expect(assistantChatCard).toBeVisible({ timeout: E2E_TIMEOUTS.cardVisibility });

    const loadingIndicator = window.getByText(/Loading assistant/i);
    if (await loadingIndicator.isVisible().catch(() => false)) {
      await loadingIndicator
        .waitFor({ state: 'hidden', timeout: E2E_TIMEOUTS.loadingIndicator })
        .catch(() => {
          throw new Error('Assistant UI chunk did not finish loading');
        });
    }

    const chatPanel = window.getByTestId('chat-panel');
    await expect(chatPanel).toBeVisible({ timeout: E2E_TIMEOUTS.chatPanel });

    const input = window.locator('#assistant-input');
    await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
    await input.fill('hi');

    const sendBtn = window.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    const reply = window.getByText('Hello from desktop assistant!').first();
    await expect(reply).toBeVisible({ timeout: E2E_TIMEOUTS.messageVisibility });

    // The action bar uses autohide="not-last" + hideWhenRunning, so it only
    // renders for the LAST, finished message. Hover the message row to float it
    // into view, then assert the bare copy button is present.
    await reply.hover();

    const copyButton = window.getByRole('button', { name: 'Copy message' }).first();
    await expect(copyButton).toBeVisible({ timeout: E2E_TIMEOUTS.toolVisibility });

    // Visual review artifact only; gitignored and never committed.
    await window.screenshot({ path: 'e2e-artifacts/hover-toolbar.png' });
  });
});
