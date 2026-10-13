import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { seedRetiredThreadRows } from './utils/seed-threads';

const root = mkdtempSync(join(tmpdir(), 'bs-e2e-current-chat-root-'));
writeFileSync(join(root, 'notes.txt'), 'Current chat acceptance fixture.\n');
test.use({ electronEnv: { BRAINSTRIKE_E2E_REAL_ROOT_PATH: root } });
test.afterAll(() => rmSync(root, { force: true, recursive: true }));

async function openCatalog(page: Page): Promise<void> {
  const show = page.getByTestId('show-threads-panel');
  if (await show.isVisible()) {
    await show.click();
  }
  await page.getByTestId('threads-tab-trigger').click();
  await expect(page.getByTestId('threads-panel')).toBeVisible();
}

async function activeConversation(page: Page): Promise<Locator> {
  const selected = page
    .getByRole('tablist', { name: 'Open assistant threads' })
    .getByRole('tab', { selected: true });
  await expect(selected).toBeVisible();
  const panelId = await selected.getAttribute('aria-controls');
  if (!panelId) {
    throw new Error('Selected conversation does not name its panel');
  }
  const panel = page.getByTestId(panelId);
  await expect(panel).toBeVisible();
  return panel;
}

async function newConversation(page: Page): Promise<Locator> {
  await page.getByTestId('assistant-new-thread-button').click();
  await expect(
    page.getByRole('tab', { exact: true, name: 'New Thread', selected: true })
  ).toBeVisible();
  return await activeConversation(page);
}

async function send(panel: Locator, prompt: string, reply: string): Promise<void> {
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeEnabled({ timeout: 30_000 });
  const before = { panelId: await panel.getAttribute('id'), value: await input.inputValue() };
  await input.fill(prompt);
  const after = { panelId: await panel.getAttribute('id'), value: await input.inputValue() };
  await test.info().attach('composer-target', {
    body: JSON.stringify({ after, before }),
    contentType: 'application/json',
  });
  await expect(input).toHaveValue(prompt);
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(panel.getByText(reply, { exact: true })).toBeVisible({ timeout: 30_000 });
}

test('@smoke every offered chat opens, New sends, and current conversations survive reload and full quit', async ({
  electron,
  modelProvider,
  window,
}) => {
  test.setTimeout(180_000);
  let page = window;
  await configureAssistantProvider(page);
  await ensureAssistantShellVisible(page);
  let title = 'First current conversation';
  let reply = 'First current reply.';
  modelProvider.setScript(({ requestBody }) => ({
    finalText: (requestBody as { stream?: unknown }).stream === true ? reply : title,
  }));
  await send(await activeConversation(page), 'First current message.', reply);
  await expect(page.getByRole('tab', { exact: true, name: title })).toBeVisible({
    timeout: 30_000,
  });
  await ensureMockWorkspaceOpen(page);
  await ensureAssistantShellVisible(page);
  const second = await newConversation(page);
  title = 'Second current conversation';
  reply = 'Second current reply.';
  await send(second, 'Second current message.', reply);
  await expect(page.getByRole('tab', { exact: true, name: title })).toBeVisible({
    timeout: 30_000,
  });

  const [retired] = await seedRetiredThreadRows(page, [
    { folder: null, title: 'Retired conversation' },
  ]);
  if (!retired) {
    throw new Error('Retired fixture was not seeded');
  }
  // A saved tab is UI state, not permission to reopen a retired conversation.
  await page.evaluate((id) => {
    const key = 'brainstrike-assistant-threads-v1';
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as {
      state: {
        activeThreadIdByResourceId: Record<string, string>;
        selectedThreadByResourceId: Record<string, string>;
        openThreadIdsByResourceId: Record<string, string[]>;
      };
    };
    saved.state.activeThreadIdByResourceId['brainstrike:workspace'] = id;
    saved.state.selectedThreadByResourceId['brainstrike:workspace'] = id;
    saved.state.openThreadIdsByResourceId['brainstrike:workspace'] = [id];
    localStorage.setItem(key, JSON.stringify(saved));
  }, retired);
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, 'current-chat-saved-retired-tab');
  await ensureAssistantShellVisible(page);
  await expect(page.getByText(/Your saved conversation is unavailable/)).toBeVisible();
  await expect(page.getByTestId('assistant-new-thread-button')).toBeEnabled();

  const inspectAllChats = async (): Promise<void> => {
    await openCatalog(page);
    const rows = page.getByTestId('thread-row');
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await expect(rows.filter({ hasText: 'Retired conversation' })).toHaveCount(0);
    for (const [name, text] of [
      ['First current conversation', 'First current reply.'],
      ['Second current conversation', 'Second current reply.'],
    ] as const) {
      await rows.filter({ hasText: name }).getByRole('button', { exact: true, name }).click();
      const assistant = page.getByRole('region', { exact: true, name: 'Assistant' });
      await expect(assistant.getByText(text, { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(assistant.getByRole('textbox', { name: 'Message input' })).toBeEnabled();
    }
  };
  await inspectAllChats();
  await electron.closeForStateSeeding();
  page = await electron.ensureWindow();
  await ensureAssistantShellVisible(page);
  await inspectAllChats();
  const third = await newConversation(page);
  title = 'Third current conversation';
  reply = 'New chat after reopen works.';
  await send(third, 'A new message after reopening.', reply);
  expect(modelProvider.refusals()).toEqual([]);
});
