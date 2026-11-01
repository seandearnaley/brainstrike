import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { reloadRenderer } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { seedHostThreads } from './utils/seed-threads';

const TITLE = 'Release plan';
const UNTITLED = 'Untitled thread';

async function openThreadsPanel(page: Page): Promise<void> {
  const showSidebar = page.getByTestId('show-threads-panel');
  if (await showSidebar.isVisible().catch(() => false)) {
    await showSidebar.click();
  }
  await expect(page.getByTestId('threads-panel')).toBeVisible({ timeout: 30_000 });
}

/** Opens the thread's customization panel from its row actions. */
async function customize(page: Page, title: string) {
  const panel = page.getByTestId('threads-panel');
  await panel.getByRole('button', { exact: true, name: `Thread actions ${title}` }).click();
  await page.getByRole('button', { exact: true, name: 'Customize' }).click();
  const customization = page.getByTestId('thread-customization-panel');
  await expect(customization).toBeVisible();
  return customization;
}

/** Title, colour and icon of a host thread, set through the UI, survive a reload. */
test('a host thread keeps its title, colour and icon across a reload', async ({
  electron,
  modelProvider,
  window,
}) => {
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  await ensureAssistantShellVisible(window);
  // The committed host conversation renders this thread, so it is host-owned.
  await expect(window.getByRole('region', { exact: true, name: 'Assistant' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(window.getByTestId('chat-panel')).toHaveCount(0);
  // New creates nothing until a first send, so the thread is created through the host.
  await seedHostThreads(electron.getUserDataDir(), [{ folder: null, title: UNTITLED }]);
  await reloadRenderer(window, 'host-thread-metadata: seed');
  await ensureAssistantShellVisible(window);
  await openThreadsPanel(window);
  const threads = window.getByTestId('threads-panel');
  const strip = window.getByRole('tablist', { name: 'Open assistant threads' });
  await threads
    .getByTestId('thread-row')
    .getByRole('button', { exact: true, name: UNTITLED })
    .click();
  await expect(strip.getByRole('tab', { name: UNTITLED })).toHaveCount(1, { timeout: 30_000 });

  await threads.getByRole('button', { exact: true, name: `Thread actions ${UNTITLED}` }).click();
  await window.getByRole('button', { exact: true, name: 'Rename' }).click();
  const titleInput = window.getByRole('textbox', { exact: true, name: 'Thread title' });
  await titleInput.fill(TITLE);
  await window.getByRole('button', { exact: true, name: 'Save thread title' }).click();
  await expect(strip.getByRole('tab', { name: TITLE })).toHaveCount(1, { timeout: 30_000 });

  let customization = await customize(window, TITLE);
  await customization.getByRole('button', { exact: true, name: 'Use Rocket icon' }).click();
  await expect(
    customization.getByRole('button', { exact: true, name: 'Use Rocket icon' })
  ).toHaveAttribute('aria-pressed', 'true');
  await customization.getByRole('button', { exact: true, name: 'Use Emerald color' }).click();
  await expect(
    customization.getByRole('button', { exact: true, name: 'Use Emerald color' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(window.getByRole('alert')).toHaveCount(0);
  // The open conversation takes the thread's colour, its agent replies included.
  const conversation = window.getByRole('region', { exact: true, name: 'Assistant' });
  await expect(conversation).toHaveAttribute('data-agent-color', 'emerald');

  await reloadRenderer(window, 'host-thread-metadata: reload');
  await ensureAssistantShellVisible(window);
  await openThreadsPanel(window);
  await expect(strip.getByRole('tab', { name: TITLE })).toHaveCount(1, { timeout: 30_000 });
  customization = await customize(window, TITLE);
  await expect(
    customization.getByRole('button', { exact: true, name: 'Use Rocket icon' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    customization.getByRole('button', { exact: true, name: 'Use Emerald color' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(conversation).toHaveAttribute('data-agent-color', 'emerald');
  expect(modelProvider.refusals()).toEqual([]);
});
