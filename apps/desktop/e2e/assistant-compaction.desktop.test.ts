import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import {
  readAssistantMockRequests,
  seedCompactionSummaryThread,
  setupAssistantMock,
} from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const FOLLOW_UP_PROMPT = 'Continue after the compacted context.';
const FOLLOW_UP_REPLY = 'Normal reply after compaction.';

async function waitForAssistantChat(window: Page): Promise<void> {
  await expect(await ensureAssistantShellVisible(window)).toBeVisible({
    timeout: E2E_TIMEOUTS.cardVisibility,
  });
  const loadingIndicator = window.getByText(/Loading assistant/i);
  if (await loadingIndicator.isVisible().catch(() => false)) {
    await loadingIndicator.waitFor({
      state: 'hidden',
      timeout: E2E_TIMEOUTS.loadingIndicator,
    });
  }
  await expect(window.getByTestId('chat-panel').filter({ visible: true })).toBeVisible({
    timeout: E2E_TIMEOUTS.chatPanel,
  });
}

test.describe('assistant compaction summary (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await setupAssistantMock(window, { variant: 'simple' });
    await ensureMockWorkspaceOpen(window);
    await waitForAssistantChat(window);
  });

  test('renders the durable divider and keeps the same thread usable afterward', async ({
    window,
  }) => {
    const seeded = await seedCompactionSummaryThread(window);

    // History adapters load once per thread runtime. Reload after the fixed
    // durable fixture is inserted, then select that thread for its first mount.
    await window.reload();
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await ensureMockWorkspaceOpen(window);
    await waitForAssistantChat(window);

    await window.getByRole('button', { exact: true, name: seeded.title }).click();

    const card = window.getByTestId('compaction-summary-card');
    await expect(card).toBeVisible({ timeout: E2E_TIMEOUTS.messageVisibility });
    await expect(card).toContainText('Conversation compacted');
    await expect(card).toContainText('AI-generated summary');
    await expect(card).toContainText('Keep the compaction divider visible.');
    // Select the provider on the hydrated target thread, not the previous tab.
    await setupAssistantMock(window, { message: FOLLOW_UP_REPLY, variant: 'simple' });

    const input = window.getByRole('textbox', { name: 'Message input' });
    await input.fill(FOLLOW_UP_PROMPT);
    await window.getByRole('button', { exact: true, name: 'Send' }).click();

    await expect(window.getByText(FOLLOW_UP_PROMPT).first()).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });
    const normalReply = window
      .locator('.aui-assistant-message-content')
      .filter({ hasText: FOLLOW_UP_REPLY });
    await expect(normalReply).toBeVisible({ timeout: E2E_TIMEOUTS.messageVisibility });
    await expect(card.getByText(FOLLOW_UP_REPLY)).toHaveCount(0);

    const [cardBox, replyBox] = await Promise.all([card.boundingBox(), normalReply.boundingBox()]);
    expect(cardBox).not.toBeNull();
    expect(replyBox).not.toBeNull();
    expect(replyBox?.y ?? 0).toBeGreaterThan((cardBox?.y ?? 0) + (cardBox?.height ?? 0));

    const requests = await readAssistantMockRequests(window);
    expect(requests).toHaveLength(1);
    // Memory-backed transport sends only the new turn. Mastra recalls the
    // durable summary by thread ID; replaying it in this POST duplicates history.
    expect(requests[0]).toMatchObject({
      data: {
        memory: { threadId: seeded.threadId },
        transportCompaction: {
          originalMessageCount: 2,
          sentMessageCount: 1,
          strategy: 'mastra-memory-current-turn',
        },
      },
      messages: [{ content: [{ text: FOLLOW_UP_PROMPT }], role: 'user' }],
    });
    // Verify the complete durable summary remains available after the new turn.
    await window.reload();
    await mockFileSystemOperations(window);
    await ensureMockWorkspaceOpen(window);
    await waitForAssistantChat(window);
    await window.getByRole('button', { exact: true, name: seeded.title }).click();
    await expect(window.getByTestId('compaction-summary-card')).toContainText(seeded.summaryText);
  });
});
