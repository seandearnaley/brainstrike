/**
 * ADR-0034 scratch threads (Sean, 2026-11-12): in a fresh profile with no
 * folder open, a thread's first message works in a folder the host makes for
 * it under the profile's `scratch/` folder, so a file the model writes lands
 * there from that first message, and the Explorer shows that folder.
 *
 * Drives the built app over a disposable profile: the host's scratch folders,
 * its root registry and trust writer, the thread binding and the renderer's
 * first send are the production ones; only the model is scripted.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { getContextExplorerFileExplorerPanel } from './utils/context-explorer-locators';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { startThread } from './utils/new-thread';
import { seedHostThreads } from './utils/seed-threads';
import { whereChip } from './utils/where-control';

const WRITE = 'brainstrike_writeWorkspaceFile';
const FINAL = 'Notes written.';

test('a first message with no folder open writes into a scratch folder the Explorer shows, a second thread gets its own, and a thread with no folder still sends', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(150_000);
  await configureAssistantProvider(page);
  // Edits run without asking, so the write is the model's first and only step.
  await new HomePage(page).openSettings();
  await new SettingsPage(page).openCategory(/Permissions/iu, 'permissions');
  await page.getByTestId('permission-policy-edit').selectOption('allow');
  modelProvider.setScript(({ requestBody, toolNames }) =>
    (requestBody as { stream?: unknown }).stream === true && toolNames.includes(WRITE)
      ? {
          finalText: FINAL,
          toolCall: { arguments: { content: 'scratch notes\n', path: 'notes.txt' }, name: WRITE },
        }
      : { finalText: 'Scratch notes' }
  );
  await ensureAssistantShellVisible(page);
  const scratch = path.join(electron.getUserDataDir(), 'scratch');
  // A fresh profile: nothing is open, and no scratch folder exists before a thread sends.
  await expect(readdir(scratch)).rejects.toMatchObject({ code: 'ENOENT' });

  const thread = await startThread(page, 'Write notes.txt.');
  await expect(thread.getByText(FINAL, { exact: true })).toBeVisible({ timeout: 60_000 });

  // One folder, made under the profile's scratch folder, holds the file the model wrote.
  const [name, ...others] = await readdir(scratch);
  expect(others).toEqual([]);
  expect(await readFile(path.join(scratch, name ?? '', 'notes.txt'), 'utf8')).toBe(
    'scratch notes\n'
  );
  // The Explorer shows that folder, by its own name, as the folder the thread works in.
  await expect(page.getByTestId('single-root-header-row')).toContainText(`${name} · Local`, {
    timeout: 30_000,
  });
  await expect(
    getContextExplorerFileExplorerPanel(page).getByText('notes.txt', { exact: true })
  ).toBeVisible({ timeout: 30_000 });
  // The composer's where-control names it the same way.
  await expect(whereChip(thread)).toHaveAccessibleName(`Where this thread works: ${name} · Local`, {
    timeout: 30_000,
  });
  // The Threads panel lists it in its Scratch section, not in a section named by its folder, and
  // its row's chip names the folder.
  const threadsPanel = page.getByTestId('threads-panel');
  const scratchSection = threadsPanel.getByTestId('thread-folder-header').filter({
    hasText: 'Scratch',
  });
  await expect(scratchSection.getByTestId('thread-folder-count')).toHaveText('1', {
    timeout: 30_000,
  });
  await expect(threadsPanel.getByTestId('thread-folder-header')).toHaveCount(1);
  await expect(threadsPanel.getByTitle(`Scratch folder ${name} at `)).toHaveCount(1);

  // A second new thread, while the Explorer's focus is still the first thread's folder: that
  // folder is not this thread's, so its send names no folder of another thread and runs in a
  // scratch folder of its own.
  const second = await startThread(page, 'Write notes.txt here too.');
  await expect(second.getByText(FINAL, { exact: true })).toBeVisible({ timeout: 60_000 });
  const folders = await readdir(scratch);
  expect(folders).toHaveLength(2);
  const [secondName] = folders.filter((folder) => folder !== name);
  expect(await readFile(path.join(scratch, secondName ?? '', 'notes.txt'), 'utf8')).toBe(
    'scratch notes\n'
  );
  await expect(page.getByTestId('single-root-header-row')).toContainText(`${secondName} · Local`, {
    timeout: 30_000,
  });
  // Both scratch threads share the one Scratch section, each chipped with its own folder.
  await expect(scratchSection.getByTestId('thread-folder-count')).toHaveText('2', {
    timeout: 30_000,
  });
  await expect(threadsPanel.getByTestId('thread-folder-header')).toHaveCount(1);
  await expect(threadsPanel.getByTitle(`Scratch folder ${secondName} at `)).toHaveCount(1);

  // A thread with no folder of its own, opened while the Explorer's focus is a scratch thread's
  // folder, which it cannot see: its send names no folder, and it is answered.
  await seedHostThreads(electron.getUserDataDir(), [{ folder: null, title: 'No folder' }]);
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, 'scratch-thread: a thread with no folder');
  await ensureAssistantShellVisible(page);
  await page
    .getByTestId('threads-panel')
    .getByRole('button', { exact: true, name: 'No folder' })
    .click();
  const tab = page
    .getByRole('tablist', { name: 'Open assistant threads' })
    .getByRole('tab', { name: 'No folder', selected: true });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  const unbound = page.locator(`[id="${await tab.getAttribute('aria-controls')}"]`);
  modelProvider.setScript(() => ({ finalText: 'Answered with no folder.' }));
  await unbound.getByRole('textbox', { name: 'Message input' }).fill('Say hello.');
  await unbound.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(unbound.getByText('Answered with no folder.', { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  expect(modelProvider.refusals()).toEqual([]);
});
