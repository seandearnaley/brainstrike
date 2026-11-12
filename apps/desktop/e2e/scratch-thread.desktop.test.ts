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
import { startThread } from './utils/new-thread';
import { whereChip } from './utils/where-control';

const WRITE = 'brainstrike_writeWorkspaceFile';
const FINAL = 'Notes written.';

test('a first message with no folder open writes into a scratch folder the Explorer shows', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(120_000);
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
  expect(modelProvider.refusals()).toEqual([]);
});
