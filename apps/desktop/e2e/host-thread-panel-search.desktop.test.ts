/**
 * Desktop E2E (gap 10): the Threads panel search finds agent-host threads by
 * their content and by their title, fused with history threads into one list.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { seedThreadRows, waitForMastraMemorySchema } from './utils/seed-threads';
import { E2E_TIMEOUTS } from './utils/timeouts';

const WORD = 'marigold';
const HISTORY_TITLE = 'Watering notes';
const CONTENT_TITLE = 'Garden plan';
const TITLE_MATCH = 'Marigold seeds';
const REPLY = 'Noted.';
const WORKSPACE_MEMORY_RESOURCE_ID = 'brainstrike:workspace';

async function openThreadsPanel(page: Page): Promise<void> {
  const showSidebar = page.getByTestId('show-threads-panel');
  if (await showSidebar.isVisible().catch(() => false)) {
    await showSidebar.click();
  }
  await page.getByTestId('threads-tab-trigger').click();
  await expect(page.getByTestId('threads-panel')).toBeVisible({ timeout: 30_000 });
}

/** A history (PGlite) user message, in the shape Mastra persists. */
async function seedHistoryMessage(page: Page, threadId: string, text: string): Promise<void> {
  await page.evaluate(
    async ({ resourceId, text: body, threadId: thread }) => {
      const query = window.electronAPI?.db?.query;
      if (!query) {
        throw new Error('Electron db.query bridge is not available');
      }
      await query(
        `INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId") VALUES ($1, $2, $3::jsonb, 'user', 'v2', NOW(), $4)`,
        [
          `${thread}-message`,
          thread,
          JSON.stringify({ content: body, format: 2, parts: [{ text: body, type: 'text' }] }),
          resourceId,
        ]
      );
    },
    { resourceId: WORKSPACE_MEMORY_RESOURCE_ID, text, threadId }
  );
}

test('the Threads panel finds host threads by content and title, in one list with history', async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(page);
  await ensureMockWorkspaceOpen(page);
  await configureAssistantProvider(page);
  await waitForMastraMemorySchema(page);
  // History: a thread whose message mentions the word; its title does not.
  const [history] = await seedThreadRows(page, [{ folder: null, title: HISTORY_TITLE }]);
  if (!history) {
    throw new Error('The history thread was not seeded');
  }
  await seedHistoryMessage(page, history, `Water the ${WORD} beds at dawn.`);

  // Each run streams; its thread's title request is the one non-streaming request.
  let title = CONTENT_TITLE;
  modelProvider.setScript(({ requestBody }) =>
    (requestBody as { stream?: unknown }).stream === true
      ? { finalText: REPLY }
      : { finalText: title }
  );
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const strip = page.getByRole('tablist', { name: 'Open assistant threads' });
  const send = async (prompt: string, titled: string): Promise<void> => {
    const input = region.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
    // A new host thread's composer mounts once its committed view connects.
    await expect(async () => {
      await input.fill(prompt);
      await expect(input).toHaveValue(prompt, { timeout: 1000 });
    }).toPass({ timeout: 30_000 });
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(strip.getByRole('tab', { name: titled })).toHaveCount(1, { timeout: 60_000 });
  };
  // A host thread found by its content.
  await send(`Plan the ${WORD} garden.`, CONTENT_TITLE);
  // A host thread found by its title alone.
  title = TITLE_MATCH;
  const newThread = page.getByTestId('assistant-new-thread-button');
  await expect(newThread).toBeEnabled({ timeout: 15_000 });
  await newThread.click();
  await expect(strip.getByRole('tab', { name: 'New Thread', selected: true })).toBeVisible({
    timeout: 30_000,
  });
  await send('Hello there.', TITLE_MATCH);

  await openThreadsPanel(page);
  await page.getByRole('combobox', { name: 'Search threads' }).fill(WORD);
  const results = page.getByTestId('thread-search-result');
  await expect(results).toHaveCount(3, { timeout: 30_000 });
  // One fused list whose owners are peers: history's best content match, the
  // host's best content match, then the host's title match, all ranked first.
  await expect(results.nth(0)).toContainText(HISTORY_TITLE);
  await expect(results.nth(0).getByTestId('thread-search-match')).toContainText(WORD);
  await expect(results.nth(1)).toContainText(CONTENT_TITLE);
  await expect(results.nth(1).getByTestId('thread-search-match')).toContainText(
    `Plan the ${WORD} garden.`
  );
  await expect(results.nth(2)).toContainText(TITLE_MATCH);
  await expect(results.nth(2).getByTestId('thread-search-match')).toHaveCount(0);

  // A host result opens its thread.
  await results.nth(1).click();
  await expect(strip.getByRole('tab', { name: CONTENT_TITLE, selected: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(modelProvider.refusals()).toEqual([]);
});
