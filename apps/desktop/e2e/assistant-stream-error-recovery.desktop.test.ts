import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const FIRST_PROMPT = 'Trigger a stream failure';
const SECOND_PROMPT = 'second message';
const STREAM_ERROR_MESSAGE = 'Simulated stream failure.';

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

  const sendBtn = window.getByRole('button', { name: 'Send' });
  await expect(sendBtn).toBeVisible();
  await expect(sendBtn).toBeEnabled();
  await sendBtn.click();

  await expect(window.getByText(prompt).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
}

test.describe('Assistant stream error recovery (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await ensureMockWorkspaceOpen(window);
  });

  test('thread recovers to a terminal state after a stream error', async ({ window }) => {
    await setupAssistantMock(window, {
      variant: 'stream-error',
      errorMessage: STREAM_ERROR_MESSAGE,
    });
    await openAssistantChat(window);
    await sendPrompt(window, FIRST_PROMPT);

    // The stream error must surface in the thread (no silent failure).
    await expect(window.getByText(STREAM_ERROR_MESSAGE).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.toolVisibility,
    });

    // Terminal-state signal: when the run ends the composer swaps its "Stop"
    // affordance back to "Send" (the Send button only renders via
    // `ThreadPrimitive.If running={false}`). A hung thread would keep running
    // and only ever show the "Stop" button. The library keeps Send disabled
    // while the input is empty, so emptiness is asserted via the absent "Stop".
    const sendBtn = window.getByRole('button', { name: 'Send' });
    await expect(sendBtn).toBeVisible({ timeout: E2E_TIMEOUTS.toolVisibility });
    await expect(window.getByRole('button', { name: 'Stop' })).toHaveCount(0);

    // Strongest proof of recovery: a second prompt can be sent and appears in
    // the thread. `sendPrompt` fills the input (re-enabling Send), clicks it,
    // and waits for the prompt text. This only succeeds if the prior run
    // reached a terminal state.
    await sendPrompt(window, SECOND_PROMPT);
    await expect(window.getByText(SECOND_PROMPT).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });
  });
});
