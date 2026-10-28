/**
 * An open composer popover closes when another thread is selected. Each thread
 * keeps its panel mounted and hides it, so a popover left open would lose its
 * anchor and float to the window's top-left corner.
 */
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { createTempDirTracker, freshRepo } from './utils/git-fixtures';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { seedRoot } from './utils/seed-root';

const tempDirs = createTempDirTracker();

test.afterAll(() => {
  tempDirs.removeAll();
});

test('selecting another thread closes the open branch menu', async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(120_000);
  const repo = freshRepo({ label: 'repo', prefix: 'bst-branch-menu-', tracker: tempDirs });
  await seedRoot(page, repo, {
    disableBackgroundIndexing: true,
    reloadReason: 'branch-menu-thread-switch',
    rootId: 'branch-menu-thread-switch-root-0000-4000-8000-000000000001',
  });
  await configureAssistantProvider(page);
  modelProvider.setScript((request) =>
    JSON.stringify(request.messages).includes('second thread')
      ? { finalText: 'Second reply.' }
      : { finalText: 'First reply.' }
  );
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = region.getByRole('textbox', { name: 'Message input' });
  await input.fill('The first thread.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText('First reply.')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'New thread' }).click();
  await input.fill('The second thread.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText('Second reply.')).toBeVisible({ timeout: 60_000 });

  const menu = page.getByTestId('workspace-bar-branch-menu');
  const rows = page
    .getByRole('treegrid', { name: 'Workspace threads' })
    .getByRole('row', { level: 2 });
  const tabs = page.getByTestId('assistant-thread-tab-strip');

  // From the Threads panel.
  await region.getByTestId('workspace-bar-branch-chip').click();
  await expect(menu).toBeVisible();
  await rows.filter({ hasText: 'First reply.' }).getByRole('button').first().click();
  await expect(tabs.getByRole('tab', { selected: true })).toContainText('First reply.');
  await expect(menu).toHaveCount(0);

  // From the thread tabs.
  await region.getByTestId('workspace-bar-branch-chip').click();
  await expect(menu).toBeVisible();
  await tabs.getByRole('tab', { name: /Second reply\./ }).click();
  await expect(tabs.getByRole('tab', { selected: true })).toContainText('Second reply.');
  await expect(menu).toHaveCount(0);
});
