/**
 * ADR-0034 build decisions: Locate folder… reconnects a project folder that moved outside the app.
 * A repository opened from the picker gets a project name and a thread; with the app closed its
 * folder is renamed on disk, and after a restart the project's section offers Locate folder….
 * Pointed at the new place, the section keeps its name and its thread, stops offering Locate
 * folder…, and the thread follows the folder (BST-2516): its where-control names the new place,
 * and its file tools read from there.
 *
 * Drives the built app over a disposable profile. Test mode's folder picker answers
 * `BRAINSTRIKE_E2E_REAL_ROOT_PATH`, read on every pick, so the spec points it at the folder before
 * each pick; only the model is scripted.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { chooseThreadFolder } from './utils/choose-thread-folder';
import { initRepo } from './utils/git-fixtures';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startThread } from './utils/new-thread';
import { whereChip } from './utils/where-control';

const READ = 'brainstrike_readWorkspaceFile';
const PROJECT = 'Survey journal';
const NOTES = 'moved-notes.txt';
/** Written only at the folder's new place, so a read that returns it read from there. */
const MOVED_CONTENT = 'written after the folder moved\n';
const READ_PROMPT = `Read ${NOTES}.`;
const READ_REPLY = 'Read the notes at the new place.';

/** The next folder test mode's picker answers. */
async function pickNext(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate((_electron, picked) => {
    process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = picked;
  }, folder);
}

/** The Threads panel's section header named `label`. */
function section(page: Page, label: string) {
  return page
    .getByTestId('threads-panel')
    .getByTestId('thread-folder-header')
    .filter({ hasText: label });
}

/** Opens the menu of the project section named `label`. */
async function openProjectActions(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { exact: true, name: `Project actions ${label}` }).click();
  await expect(page.getByRole('button', { name: 'Rename project…' })).toBeVisible();
}

test('Locate folder… reconnects a project folder moved outside the app, keeping its name and its thread', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(150_000);
  const place = path.join(electron.getWorkspaceRoot(), 'survey-repo');
  const moved = path.join(electron.getWorkspaceRoot(), 'survey-repo-moved');
  await mkdir(place);
  initRepo(place);
  modelProvider.setScript(({ messages, requestBody, toolNames }) => {
    if ((requestBody as { stream?: unknown }).stream !== true) {
      return { finalText: 'Survey thread' };
    }
    const transcript = JSON.stringify(messages);
    if (!transcript.includes(READ_PROMPT)) {
      return { finalText: 'Started.' };
    }
    if (!toolNames.includes(READ)) {
      return { finalText: `The thread was not offered ${READ}.` };
    }
    // The read's result is the file's content only when the tool found the file at the new place.
    return {
      finalText: transcript.includes(MOVED_CONTENT.trim())
        ? READ_REPLY
        : 'The notes were not read.',
      toolCall: { arguments: { path: NOTES }, name: READ },
    };
  });

  // A repository opened from the picker, its project named, and a thread started in it.
  await configureAssistantProvider(page);
  await pickNext(electronApp.app, place);
  await ensureMockWorkspaceOpen(page);
  await ensureAssistantShellVisible(page);
  await chooseThreadFolder(page.getByTestId('new-thread-welcome'), path.basename(place));
  const thread = await startThread(page, 'Start here.');
  await expect(thread.getByText('Started.', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(section(page, path.basename(place)).getByTestId('thread-folder-count')).toHaveText(
    '1',
    { timeout: 30_000 }
  );
  await openProjectActions(page, path.basename(place));
  await page.getByRole('button', { name: 'Rename project…' }).click();
  const name = page.getByRole('textbox', { name: 'Project name' });
  await name.fill(PROJECT);
  await name.press('Enter');
  await expect(section(page, PROJECT).getByTestId('thread-folder-count')).toHaveText('1', {
    timeout: 30_000,
  });

  // The folder moves while the app is closed: after a restart it is not at its place.
  await electron.closeForStateSeeding();
  await rename(place, moved);
  await writeFile(path.join(moved, NOTES), MOVED_CONTENT);
  const reopened = await electron.restart();
  const next = reopened.window;
  await configureAssistantProvider(next);
  await ensureAssistantShellVisible(next);
  const project = section(next, PROJECT);
  await expect(project.getByTestId('thread-folder-count')).toHaveText('1', { timeout: 30_000 });

  await pickNext(reopened.app, moved);
  await openProjectActions(next, PROJECT);
  await next.getByRole('button', { name: 'Locate folder…' }).click();

  // The same section, at the new place: named as the person named it, holding its thread.
  await expect(project.getByTitle(moved, { exact: true })).toHaveCount(1, { timeout: 30_000 });
  await expect(next.getByTestId('thread-project-action-error')).toHaveCount(0);
  await expect(project.getByTestId('thread-folder-count')).toHaveText('1');
  await expect(next.getByTestId('threads-panel').getByTestId('thread-folder-header')).toHaveCount(
    1
  );
  // The folder is where its record says, so there is nothing left to locate.
  await openProjectActions(next, PROJECT);
  await expect(next.getByRole('button', { name: 'Locate folder…' })).toHaveCount(0);
  await next.keyboard.press('Escape');

  // The thread's file tools work in the new place.
  await next
    .getByTestId('threads-panel')
    .getByTestId('thread-row')
    .getByRole('button')
    .first()
    .click();
  const tab = next
    .getByRole('tablist', { name: 'Open assistant threads' })
    .getByRole('tab', { selected: true });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  const reconnected = next.locator(`[id="${await tab.getAttribute('aria-controls')}"]`);
  await expect(whereChip(reconnected)).toHaveAccessibleName(
    `Where this thread works: ${path.basename(moved)} · Local`,
    { timeout: 30_000 }
  );
  await reconnected.getByRole('textbox', { name: 'Message input' }).fill(READ_PROMPT);
  await reconnected.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(reconnected.getByText(READ_REPLY, { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  expect(modelProvider.refusals()).toEqual([]);
});
