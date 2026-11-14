/**
 * ADR-0034 build decisions (BST-2513): New project folder… gives a thread that works with no
 * folder of its own a new folder the person places. A thread first sent while a folder is open
 * runs against the open folders and has no binding; once the folder is closed, the where-control
 * offers "New project folder…". The picker answers a folder of the person's, the host makes a
 * folder there named by the thread's title, opens it as a project and binds the thread, and the
 * thread's next message writes into it.
 *
 * Drives the built app over a disposable profile. Test mode's folder picker answers the folder
 * `BRAINSTRIKE_E2E_REAL_ROOT_PATH` names in Main, which the spec sets per call; every folder is
 * made under this test's workspace root. Only the model is scripted.
 */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderShim } from './utils/model-provider-shim';
import { startThread } from './utils/new-thread';
import { openWhereMenu, whereChip } from './utils/where-control';

const WRITE = 'brainstrike_writeWorkspaceFile';
const TITLE = 'Project notes';

/**
 * Each send writes `notes.txt` with what `content` answers then, and the thread's title request
 * answers `TITLE`. Edits run without asking, so each write is the model's first and only step.
 */
async function scriptNotesWrites(
  page: Page,
  modelProvider: ModelProviderShim,
  content: () => string
): Promise<void> {
  await configureAssistantProvider(page);
  await new HomePage(page).openSettings();
  await new SettingsPage(page).openCategory(/Permissions/iu, 'permissions');
  await page.getByTestId('permission-policy-edit').selectOption('allow');
  modelProvider.setScript(({ requestBody, toolNames }) =>
    (requestBody as { stream?: unknown }).stream === true && toolNames.includes(WRITE)
      ? {
          finalText: `Wrote ${content().trim()}.`,
          toolCall: { arguments: { content: content(), path: 'notes.txt' }, name: WRITE },
        }
      : { finalText: TITLE }
  );
  await ensureAssistantShellVisible(page);
}

/** The person closes a folder: right-click its Explorer header, Disconnect…, Disconnect. */
async function disconnect(page: Page, name: string): Promise<void> {
  await ensureFileExplorerPanelVisible(page);
  await page
    .getByRole('tablist', { name: 'Explorer and search' })
    .getByRole('tab', { name: 'Explorer' })
    .click();
  // One open folder heads the Explorer alone; several each head a section.
  const header = page
    .locator('[data-testid="single-root-header-row"], [data-testid="root-section-header-row"]')
    .filter({ hasText: name });
  await header.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Disconnect…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { exact: true, name: 'Disconnect' }).click();
  await expect(header).toHaveCount(0, { timeout: 30_000 });
}

test('a thread with no folder of its own gets a new project folder where the person places it, and its next message writes there', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(150_000);
  let content = 'open folder notes\n';
  await scriptNotesWrites(page, modelProvider, () => content);
  const workspace = electron.getWorkspaceRoot();
  const projects = path.join(workspace, 'Projects');
  await mkdir(projects);

  // A folder is open at the first send, so the thread works with no folder of its own: its write
  // lands in the open folder, and no scratch folder is made.
  await ensureMockWorkspaceOpen(page);
  const thread = await startThread(page, 'Write notes.txt.');
  await expect(thread.getByText('Wrote open folder notes.', { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  expect(await readFile(path.join(workspace, 'notes.txt'), 'utf8')).toBe('open folder notes\n');
  const scratch = path.join(electron.getUserDataDir(), 'scratch');
  expect(await readdir(scratch).catch(() => [])).toEqual([]);
  // The folder is named by the thread's title, once the thread has one.
  await expect(
    page
      .getByRole('tablist', { name: 'Open assistant threads' })
      .getByRole('tab', { selected: true })
  ).toContainText(TITLE, { timeout: 30_000 });

  // The person closes the folder, then asks for a new project folder in the folder they keep
  // projects in, which the picker answers.
  await disconnect(page, path.basename(workspace));
  await electronApp.app.evaluate((_electron, picked) => {
    process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = picked;
  }, projects);
  await openWhereMenu(thread);
  await page.getByTestId('workspace-bar-new-project-folder').click();

  // The host made the folder there, named by the title, and the thread works in it.
  const place = path.join(projects, 'project-notes');
  await expect.poll(() => readdir(projects), { timeout: 30_000 }).toEqual(['project-notes']);
  await expect(whereChip(thread)).toHaveAccessibleName(
    'Where this thread works: project-notes · Local',
    { timeout: 30_000 }
  );
  await openWhereMenu(thread);
  await expect(page.getByTestId('workspace-bar-new-project-folder')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The thread's next message writes into the new folder, and the closed folder keeps its own.
  content = 'project notes\n';
  await thread.getByRole('textbox', { name: 'Message input' }).fill('Write notes.txt again.');
  await thread.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(thread.getByText('Wrote project notes.', { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  expect(await readFile(path.join(place, 'notes.txt'), 'utf8')).toBe('project notes\n');
  expect(await readFile(path.join(workspace, 'notes.txt'), 'utf8')).toBe('open folder notes\n');
  expect(await readdir(scratch).catch(() => [])).toEqual([]);
  expect(modelProvider.refusals()).toEqual([]);
});
