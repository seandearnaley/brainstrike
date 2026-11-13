/**
 * ADR-0034 build decisions: a scratch thread's folder becomes a project. In a
 * fresh profile with no folder open, a thread's first message works in a
 * scratch folder; "Turn into a project…" in the where-control moves that folder
 * into the folder the picker answers, and the thread keeps working there: its
 * next message writes into the moved folder, and the Threads panel lists it
 * under its project instead of Scratch.
 *
 * Drives the built app over a disposable profile. Test mode's folder picker
 * answers the harness's workspace folder (`BRAINSTRIKE_E2E_REAL_ROOT_PATH`),
 * on the same disk as the profile; only the model is scripted.
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
import { openWhereMenu, whereChip } from './utils/where-control';

const WRITE = 'brainstrike_writeWorkspaceFile';

test('a scratch thread turned into a project keeps working in the moved folder, listed under its project', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(150_000);
  await configureAssistantProvider(page);
  // Edits run without asking, so each write is the model's first and only step.
  await new HomePage(page).openSettings();
  await new SettingsPage(page).openCategory(/Permissions/iu, 'permissions');
  await page.getByTestId('permission-policy-edit').selectOption('allow');
  let content = 'scratch notes\n';
  modelProvider.setScript(({ requestBody, toolNames }) =>
    (requestBody as { stream?: unknown }).stream === true && toolNames.includes(WRITE)
      ? {
          finalText: `Wrote ${content.trim()}.`,
          toolCall: { arguments: { content, path: 'notes.txt' }, name: WRITE },
        }
      : { finalText: 'Project notes' }
  );
  await ensureAssistantShellVisible(page);
  const scratch = path.join(electron.getUserDataDir(), 'scratch');

  const thread = await startThread(page, 'Write notes.txt.');
  await expect(thread.getByText('Wrote scratch notes.', { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const [name] = await readdir(scratch);
  const place = path.join(electron.getWorkspaceRoot(), name ?? '');

  await openWhereMenu(thread);
  await page.getByTestId('workspace-bar-scratch-project').click();

  // The folder moved, with its work, into the folder the picker answered.
  await expect.poll(() => readdir(scratch), { timeout: 30_000 }).toEqual([]);
  expect(await readFile(path.join(place, 'notes.txt'), 'utf8')).toBe('scratch notes\n');
  // The Threads panel lists the thread under its project, named by its folder, not in Scratch.
  const threadsPanel = page.getByTestId('threads-panel');
  const headers = threadsPanel.getByTestId('thread-folder-header');
  await expect(headers.filter({ hasText: name ?? '' })).toHaveCount(1, { timeout: 30_000 });
  await expect(headers.filter({ hasText: 'Scratch' })).toHaveCount(0);
  await expect(threadsPanel.getByTitle(`Scratch folder ${name} at `)).toHaveCount(0);
  // The where-control and the Explorer name the folder where it is now.
  await expect(whereChip(thread)).toHaveAccessibleName(`Where this thread works: ${name} · Local`, {
    timeout: 30_000,
  });
  await expect(page.getByTestId('single-root-header-row')).toContainText(`${name} · Local`, {
    timeout: 30_000,
  });
  await expect(
    getContextExplorerFileExplorerPanel(page).getByText('notes.txt', { exact: true })
  ).toBeVisible({ timeout: 30_000 });

  // The thread's next message works in the project.
  content = 'project notes\n';
  await thread.getByRole('textbox', { name: 'Message input' }).fill('Write notes.txt again.');
  await thread.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(thread.getByText('Wrote project notes.', { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  expect(await readFile(path.join(place, 'notes.txt'), 'utf8')).toBe('project notes\n');
  expect(await readdir(scratch)).toEqual([]);
  expect(modelProvider.refusals()).toEqual([]);
});
