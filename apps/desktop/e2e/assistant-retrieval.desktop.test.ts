import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const PROMPT_TEXT = 'Find relevant context';

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

  const chatPanel = window.getByRole('region', { exact: true, name: 'Assistant' });
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

test.describe('Assistant retrieval (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await ensureMockWorkspaceOpen(window);
  });

  test('shows retrieval tool event and response', async ({ window }) => {
    await setupAssistantMock(window, { message: 'Retrieved answer.', variant: 'tool' });
    await openAssistantChat(window);
    await sendPrompt(window, PROMPT_TEXT);

    await expect(window.getByText('Retrieved answer.').first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    // Sync on the turn actually finishing. `aria-expanded` is no longer that
    // signal: since BST-1679 the group is collapsed at ALL times, running
    // included, so waiting for "false" resolves immediately and proves
    // nothing. `data-state` is what the trace publishes for the transition.
    await expect(window.getByTestId('assistant-activity-group').first()).toHaveAttribute(
      'data-state',
      'done',
      { timeout: E2E_TIMEOUTS.toolVisibility }
    );
    const summary = window.getByTestId('assistant-activity-summary').first();
    await summary.click();
    await expect(window.getByTestId('tool-fallback').first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    // Scoped to the CARD: since BST-1679 the collapsed group header also names
    // the step ("Used brainstrike.retrieveContext"), so an unscoped text query
    // would pass on the header alone and stop proving the card renders it.
    await expect(window.getByTestId('tool-fallback').first()).toContainText(
      'brainstrike.retrieveContext',
      { timeout: E2E_TIMEOUTS.toolVisibility }
    );
  });

  test('shows retrieval tool errors when execution fails', async ({ window }) => {
    const errorMessage = 'Select an active embedding set to enable retrieval.';
    await setupAssistantMock(window, { errorMessage, variant: 'tool-error' });
    await openAssistantChat(window);
    await sendPrompt(window, PROMPT_TEXT);

    // Sync on the turn actually finishing. `aria-expanded` is no longer that
    // signal: since BST-1679 the group is collapsed at ALL times, running
    // included, so waiting for "false" resolves immediately and proves
    // nothing. `data-state` is what the trace publishes for the transition.
    await expect(window.getByTestId('assistant-activity-group').first()).toHaveAttribute(
      'data-state',
      'done',
      { timeout: E2E_TIMEOUTS.toolVisibility }
    );
    const summary = window.getByTestId('assistant-activity-summary').first();
    await summary.click();
    await expect(window.getByText(errorMessage).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    await expect(window.getByTestId('tool-fallback').first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
    // Scoped to the CARD: since BST-1679 the collapsed group header also names
    // the step ("Used brainstrike.retrieveContext"), so an unscoped text query
    // would pass on the header alone and stop proving the card renders it.
    await expect(window.getByTestId('tool-fallback').first()).toContainText(
      'brainstrike.retrieveContext',
      { timeout: E2E_TIMEOUTS.toolVisibility }
    );
  });

  test('surfaces assistant stream failures', async ({ window }) => {
    const errorMessage = 'Network error while contacting assistant.';
    await setupAssistantMock(window, { errorMessage, variant: 'stream-error' });
    await openAssistantChat(window);
    await sendPrompt(window, PROMPT_TEXT);

    await expect(window.getByText(errorMessage).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });
  });
});
