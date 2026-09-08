import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const PROMPT_TEXT = 'find db files';

// Mirrored from assistant-retrieval.desktop.test.ts so the spec drives the real
// desktop assistant through the mock harness in exactly the same way.
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
  const input = window.locator('#assistant-input');
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill(prompt);

  const sendBtn = window.getByRole('button', { exact: true, name: 'Send' });
  await expect(sendBtn).toBeVisible();
  await sendBtn.click();

  await expect(window.getByText(prompt).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
}

test.describe('Assistant tool card visuals (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await ensureMockWorkspaceOpen(window);
  });

  test('tool card is compact, tinted internal, and badge-free', async ({ window }) => {
    await setupAssistantMock(window, { message: 'Retrieved answer.', variant: 'tool' });
    await openAssistantChat(window);
    await sendPrompt(window, PROMPT_TEXT);

    await expect(window.getByText('Retrieved answer.').first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    const summary = window.getByTestId('assistant-activity-summary').first();
    await expect(summary).toHaveAttribute('aria-expanded', 'false', {
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    await summary.click();
    const toolCard = window.getByTestId('tool-fallback').first();
    await expect(toolCard).toBeVisible({ timeout: E2E_TIMEOUTS.toolVisibility });
    await expect(toolCard).toHaveAttribute('data-tool-category', 'internal');
    // The refreshed card no longer renders a visible status badge; the status is
    // conveyed by the rail icon (tooltip-only label), so "Completed" is absent.
    await expect(toolCard.getByText('Completed', { exact: true })).toHaveCount(0);

    await window.screenshot({ path: 'e2e-artifacts/tool-card-success.png' });
  });

  test('tool-error card renders the error state', async ({ window }) => {
    const errorMessage = 'Boom.';
    await setupAssistantMock(window, { errorMessage, variant: 'tool-error' });
    await openAssistantChat(window);
    await sendPrompt(window, PROMPT_TEXT);

    const summary = window.getByTestId('assistant-activity-summary').first();
    await expect(summary).toHaveAttribute('aria-expanded', 'false', {
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    await expect(summary).toContainText('1 failed');
    await expect(summary).toContainText('Worked');
    await summary.click();
    const toolCard = window.getByTestId('tool-fallback').first();
    await expect(toolCard).toBeVisible({ timeout: E2E_TIMEOUTS.toolVisibility });
    // Category classification is independent of the failure state; an internal
    // tool stays tinted as internal even when its execution errors.
    await expect(toolCard).toHaveAttribute('data-tool-category', 'internal');
    await expect(toolCard.getByText(errorMessage).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });

    await window.screenshot({ path: 'e2e-artifacts/tool-card-error.png' });
  });
});
